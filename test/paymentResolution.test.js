/**
 * Paid-in-Razorpay-but-dashboard-shows-pending fixes: more webhook events,
 * capture of authorized payments, admin "check Razorpay" / "mark paid with
 * payment ID", manual payment recording and the bulk sync.
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, razorpayCalls, razorpayBehaviour, mockRes, sign } = require('./helpers/setup');
const orders = require('../controllers/orderController');

const USER = { uid: 'user1', email: 'buyer@example.com', role: 'customer' };
const ADMIN = { uid: 'admin1', email: 'admin@example.com', role: 'admin' };
const customerInfo = { firstName: 'Asha', lastName: 'K', address: '12 Main St', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', phone: '9876543210' };

beforeEach(() => {
  db.reset();
  razorpayCalls.ordersCreated.length = 0;
  razorpayCalls.captured.length = 0;
  razorpayBehaviour.createOrder = async (opts) => ({ id: `order_rzp_${razorpayCalls.ordersCreated.length}`, amount: opts.amount });
  razorpayBehaviour.fetchPayments = async () => ({ items: [] });
  razorpayBehaviour.fetchPayment = async (id) => ({ id, method: 'upi', vpa: 'test@upi', status: 'captured' });
  razorpayBehaviour.capturePayment = async (id, amount) => ({ id, amount, method: 'upi', status: 'captured' });
  db.seed('products/cookie', {
    title: 'Ragi Cookies', category: 'Cookies', price: 90, stock: 5,
    variants: [{ weight: '120g', price: 90, stock: 5 }],
  });
  db.seed('deliverySettings/global', { defaultDeliveryFee: 70, serviceByDefault: true });
});

const variantStock = () => db.read('products/cookie').variants[0].stock;

async function pendingOrder() {
  const res = mockRes();
  await orders.createOrder({ body: { customerInfo, items: [{ productId: 'cookie', selectedWeight: '120g', quantity: 1 }] }, user: USER, headers: {}, id: 'req' }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return { orderId: res.body.orderId, rzpOrderId: res.body.razorpayOrderId, total: db.read(`orders/${res.body.orderId}`).totalAmount };
}

async function call(fn, { params = {}, body = {}, user = ADMIN, query = {} } = {}) {
  const res = mockRes();
  await orders[fn]({ params, body, user, query, id: 'req', ip: '127.0.0.1' }, res);
  return res;
}

async function webhook(payload, eventId) {
  const raw = Buffer.from(JSON.stringify(payload));
  const res = mockRes();
  await orders.razorpayWebhook({
    body: raw,
    headers: { 'x-razorpay-signature': sign(process.env.RAZORPAY_WEBHOOK_SECRET, raw), 'x-razorpay-event-id': eventId },
    id: 'req',
  }, res);
  return res;
}

async function abandon(orderId) {
  const res = mockRes();
  await orders.abandonPayment({ params: { id: orderId }, user: USER, id: 'req' }, res);
  assert.equal(db.read(`orders/${orderId}`).status, 'cancelled');
}

// ── order creation ──

test('the Razorpay order carries our order ID in its notes', async () => {
  const { orderId } = await pendingOrder();
  assert.equal(razorpayCalls.ordersCreated[0].notes.orderId, orderId);
});

// ── webhook ──

test('webhook order.paid confirms the order', async () => {
  const { orderId, rzpOrderId } = await pendingOrder();
  const res = await webhook({
    event: 'order.paid',
    payload: {
      payment: { entity: { id: 'pay_op1', order_id: rzpOrderId, status: 'captured' } },
      order: { entity: { id: rzpOrderId, status: 'paid' } },
    },
  }, 'evt_op1');
  assert.equal(res.statusCode, 200);
  assert.equal(db.read(`orders/${orderId}`).status, 'pending');
  assert.equal(db.read(`orders/${orderId}`).razorpayPaymentId, 'pay_op1');
});

test('webhook payment.authorized captures the payment and confirms the order', async () => {
  const { orderId, rzpOrderId, total } = await pendingOrder();
  razorpayBehaviour.fetchPayment = async (id) => ({ id, amount: total * 100, currency: 'INR', method: 'card', status: 'authorized' });
  const res = await webhook({
    event: 'payment.authorized',
    payload: { payment: { entity: { id: 'pay_auth', order_id: rzpOrderId, status: 'authorized' } } },
  }, 'evt_auth');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(razorpayCalls.captured[0], { id: 'pay_auth', amount: total * 100, currency: 'INR' });
  assert.equal(db.read(`orders/${orderId}`).status, 'pending');
});

test('webhook falls back to the order ID in the notes', async () => {
  const { orderId, rzpOrderId } = await pendingOrder();
  // Simulate a lookup miss on razorpayOrderId (e.g. field not yet indexed / written).
  const o = db.read(`orders/${orderId}`);
  db.seed(`orders/${orderId}`, { ...o, razorpayOrderId: undefined });
  await webhook({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_n1', order_id: rzpOrderId, status: 'captured', notes: { orderId } } } },
  }, 'evt_n1');
  assert.equal(db.read(`orders/${orderId}`).status, 'pending');
});

// ── admin list self-heals ──

test('admin order list confirms orders Razorpay shows as paid (pending and recently auto-cancelled)', async () => {
  const a = await pendingOrder();
  const b = await pendingOrder();
  await abandon(b.orderId);
  razorpayBehaviour.fetchPayments = async (id) => ({
    items: id === a.rzpOrderId ? [{ id: 'pay_a', status: 'captured' }]
      : id === b.rzpOrderId ? [{ id: 'pay_b', status: 'authorized' }] : [],
  });
  razorpayBehaviour.fetchPayment = async (id) => ({ id, amount: 1, method: 'upi', status: id === 'pay_b' ? 'authorized' : 'captured' });

  const res = await call('getOrders');
  assert.equal(res.statusCode, 200);
  const byId = Object.fromEntries(res.body.data.map((o) => [o.id, o]));
  assert.equal(byId[a.orderId].status, 'pending');
  assert.equal(byId[b.orderId].status, 'pending', 'late UPI payment revives the auto-cancelled order');
  assert.equal(razorpayCalls.captured.length, 1, 'authorized payment captured');
});

// ── admin: check one order with Razorpay ──

test('sync-payment without an ID reports when Razorpay has nothing', async () => {
  const { orderId } = await pendingOrder();
  const res = await call('syncOrderPayment', { params: { id: orderId } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paid, false);
  assert.equal(db.read(`orders/${orderId}`).status, 'payment_pending');
});

test('sync-payment with a Razorpay payment ID confirms after verifying it', async () => {
  const { orderId, rzpOrderId, total } = await pendingOrder();
  razorpayBehaviour.fetchPayment = async (id) => ({ id, order_id: rzpOrderId, amount: total * 100, method: 'upi', status: 'captured' });
  const res = await call('syncOrderPayment', { params: { id: orderId }, body: { paymentId: 'pay_ABC123xyz' } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.paid, true);
  const order = db.read(`orders/${orderId}`);
  assert.equal(order.status, 'pending');
  assert.equal(order.razorpayPaymentId, 'pay_ABC123xyz');
  assert.equal(order.paymentConfirmedBy, 'admin_sync');
});

test('sync-payment rejects a payment for a different order, a failed payment, and a reused payment', async () => {
  const { orderId, total } = await pendingOrder();
  razorpayBehaviour.fetchPayment = async (id) => ({ id, order_id: 'order_other', amount: total * 100, status: 'captured' });
  let res = await call('syncOrderPayment', { params: { id: orderId }, body: { paymentId: 'pay_OTHER1234' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /different Razorpay order/);

  razorpayBehaviour.fetchPayment = async (id) => ({ id, amount: total * 100, status: 'failed' });
  res = await call('syncOrderPayment', { params: { id: orderId }, body: { paymentId: 'pay_FAILED1234' } });
  assert.equal(res.statusCode, 400);

  db.seed('orders/someoneElse', { status: 'pending', razorpayPaymentId: 'pay_USED12345', items: [] });
  razorpayBehaviour.fetchPayment = async (id) => ({ id, amount: total * 100, status: 'captured' }); // unlinked (payment link)
  res = await call('syncOrderPayment', { params: { id: orderId }, body: { paymentId: 'pay_USED12345' } });
  assert.equal(res.statusCode, 409);

  razorpayBehaviour.fetchPayment = async (id) => ({ id, amount: total * 100 - 100, status: 'captured' });
  res = await call('syncOrderPayment', { params: { id: orderId }, body: { paymentId: 'pay_SHORT12345' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /less than/);

  assert.equal(db.read(`orders/${orderId}`).status, 'payment_pending');
});

test('sync-payment refuses an order that is already paid', async () => {
  db.seed('orders/paid', { status: 'pending', razorpayPaymentId: 'pay_x', items: [] });
  const res = await call('syncOrderPayment', { params: { id: 'paid' } });
  assert.equal(res.statusCode, 409);
});

// ── admin: manual payment ──

test('manual payment marks the order paid, records who/what, and is audit-logged', async () => {
  const { orderId, total } = await pendingOrder();
  const res = await call('markOrderPaidManually', {
    params: { id: orderId },
    body: { method: 'bank_transfer', reference: 'UTR998877', amount: total, note: 'NEFT from customer' },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const order = db.read(`orders/${orderId}`);
  assert.equal(order.status, 'pending');
  assert.equal(order.manualPayment.reference, 'UTR998877');
  assert.equal(order.manualPayment.recordedBy.uid, ADMIN.uid);
  assert.equal(order.paymentDetails.method, 'bank_transfer');
  assert.equal(db.read(`stockReservations/${order.reservationId}`).status, 'CONFIRMED');
  assert.equal(variantStock(), 4);
});

test('manual payment on an auto-cancelled order takes stock again', async () => {
  const { orderId, total } = await pendingOrder();
  await abandon(orderId);
  assert.equal(variantStock(), 5);
  const res = await call('markOrderPaidManually', { params: { id: orderId }, body: { method: 'upi', reference: 'UPI123456', amount: total } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(db.read(`orders/${orderId}`).status, 'pending');
  assert.equal(variantStock(), 4);
});

test('manual payment validates input and rejects short amounts and reused references', async () => {
  const { orderId, total } = await pendingOrder();
  let res = await call('markOrderPaidManually', { params: { id: orderId }, body: { method: 'upi', reference: '', amount: total } });
  assert.equal(res.statusCode, 400);
  res = await call('markOrderPaidManually', { params: { id: orderId }, body: { method: 'bogus', reference: 'UTR1234', amount: total } });
  assert.equal(res.statusCode, 400);
  res = await call('markOrderPaidManually', { params: { id: orderId }, body: { method: 'upi', reference: 'UTR1234', amount: total - 1 } });
  assert.equal(res.statusCode, 400);

  db.seed('orders/other', { status: 'pending', manualPayment: { reference: 'UTR-DUP-1' }, items: [] });
  res = await call('markOrderPaidManually', { params: { id: orderId }, body: { method: 'upi', reference: 'UTR-DUP-1', amount: total } });
  assert.equal(res.statusCode, 409);
  assert.equal(db.read(`orders/${orderId}`).status, 'payment_pending');
});

test('manual payment uses the Razorpay payment instead when Razorpay already has one', async () => {
  const { orderId, rzpOrderId, total } = await pendingOrder();
  razorpayBehaviour.fetchPayments = async (id) => ({ items: id === rzpOrderId ? [{ id: 'pay_real', status: 'captured' }] : [] });
  const res = await call('markOrderPaidManually', { params: { id: orderId }, body: { method: 'upi', reference: 'UPI999999', amount: total } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reconciled, true);
  const order = db.read(`orders/${orderId}`);
  assert.equal(order.razorpayPaymentId, 'pay_real');
  assert.equal(order.manualPayment, undefined);
});

test('a refund of a manually-paid order is recorded without calling Razorpay', async () => {
  const { orderId, total } = await pendingOrder();
  await call('markOrderPaidManually', { params: { id: orderId }, body: { method: 'cash', note: 'Collected at store', amount: total } });
  db.seed(`orders/${orderId}`, { ...db.read(`orders/${orderId}`), status: 'delivered' });
  const res = await call('refundOrder', { params: { id: orderId } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(db.read(`orders/${orderId}`).refundStatus, 'manual');
});

// ── admin: bulk sync ──

test('bulk sync confirms every paid order and leaves unpaid ones alone', async () => {
  const a = await pendingOrder();
  const b = await pendingOrder();
  const c = await pendingOrder();
  await abandon(c.orderId);
  razorpayBehaviour.fetchPayments = async (id) => ({
    items: id === a.rzpOrderId ? [{ id: 'pay_a', status: 'captured' }]
      : id === c.rzpOrderId ? [{ id: 'pay_c', status: 'captured' }] : [],
  });
  const res = await call('syncPendingPayments');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.checked, 3);
  assert.deepEqual(res.body.data.confirmed.sort(), [a.orderId, c.orderId].sort());
  assert.equal(db.read(`orders/${b.orderId}`).status, 'payment_pending');
});
