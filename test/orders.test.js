/**
 * Order creation, payment verification, the Razorpay webhook and stock
 * reservation — the real controller code against an in-memory Firestore and a
 * scripted Razorpay client (see helpers/setup.js).
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, razorpayCalls, razorpayBehaviour, mockRes, sign } = require('./helpers/setup');
const orders = require('../controllers/orderController');

const USER = { uid: 'user1', email: 'buyer@example.com', role: 'customer' };
const customerInfo = { firstName: 'Asha', lastName: 'K', address: '12 Main St', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', phone: '9876543210' };

function seedCatalogue() {
  db.reset();
  razorpayCalls.ordersCreated.length = 0;
  razorpayBehaviour.createOrder = async (opts) => ({ id: `order_rzp_${razorpayCalls.ordersCreated.length}`, amount: opts.amount });
  razorpayBehaviour.fetchPayments = async () => ({ items: [] });
  db.seed('products/cookie', {
    title: 'Ragi Cookies', category: 'Cookies', price: 90, stock: 5,
    variants: [{ weight: '120g', price: 90, stock: 5, shipWeightKg: 0.14, dims: { l: 14, b: 10, h: 4 } }],
  });
  db.seed('products/ghee', {
    title: 'A2 Ghee', category: 'Others', price: 450, stock: 2,
    variants: [{ weight: '500ml', price: 450, stock: 2 }],
  });
  db.seed('products/draft', { title: 'Secret', isDraft: true, variants: [{ weight: '1kg', price: 10, stock: 9 }] });
  db.seed('deliverySettings/global', { defaultDeliveryFee: 70, freeDeliveryEnabled: true, freeDeliveryThreshold: 500, serviceByDefault: true });
}

async function placeOrder(body, headers = {}) {
  const res = mockRes();
  await orders.createOrder({ body: { customerInfo, ...body }, user: USER, headers, id: 'req' }, res);
  return res;
}

const variantStock = (id) => db.read(`products/${id}`).variants[0].stock;

beforeEach(seedCatalogue);

// ── order creation ───────────────────────────────────────────────────────────

test('createOrder prices from the database, reserves stock and opens a Razorpay order', async () => {
  const res = await placeOrder({ items: [{ productId: 'cookie', selectedWeight: '120g', quantity: 2, price: 1 }] });

  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const order = db.read(`orders/${res.body.orderId}`);
  assert.equal(order.status, 'payment_pending');
  assert.equal(order.subtotal, 180, 'client price (₹1) must be ignored');
  assert.equal(order.deliveryFee, 70, 'below the free-delivery threshold');
  assert.equal(order.totalAmount, 250);
  assert.equal(razorpayCalls.ordersCreated[0].amount, 25000, 'paise');
  assert.equal(order.customerInfo.email, USER.email, 'email comes from the session, not the client');

  assert.equal(variantStock('cookie'), 3, 'stock decremented');
  const reservation = db.read(`stockReservations/${order.reservationId}`);
  assert.equal(reservation.status, 'ACTIVE');
  assert.equal(reservation.orderId, res.body.orderId);
});

test('createOrder snapshots packed weight + size onto order items for the parcel', async () => {
  const res = await placeOrder({ items: [
    { productId: 'cookie', selectedWeight: '120g', quantity: 1 },
    { productId: 'ghee', selectedWeight: '500ml', quantity: 1 },
  ] });
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const [cookie, ghee] = db.read(`orders/${res.body.orderId}`).items;
  assert.equal(cookie.shipWeightKg, 0.14);
  assert.deepEqual(cookie.dims, { l: 14, b: 10, h: 4 });
  assert.ok(!('shipWeightKg' in ghee) && !('dims' in ghee), 'no shipping data → no fields');
});

test('createOrder applies free delivery above the threshold', async () => {
  const res = await placeOrder({ items: [{ productId: 'ghee', selectedWeight: '500ml', quantity: 2 }] });
  assert.equal(res.statusCode, 201);
  assert.equal(db.read(`orders/${res.body.orderId}`).totalAmount, 900);
});

test('createOrder rejects empty carts, bad quantities and unavailable products', async () => {
  assert.equal((await placeOrder({ items: [] })).statusCode, 400);
  assert.equal((await placeOrder({ items: [{ productId: 'cookie', selectedWeight: '120g', quantity: 0 }] })).statusCode, 400);
  assert.equal((await placeOrder({ items: [{ productId: 'cookie', selectedWeight: '120g', quantity: 51 }] })).statusCode, 400);
  assert.equal((await placeOrder({ items: [{ productId: 'draft', quantity: 1 }] })).statusCode, 400);
  assert.equal((await placeOrder({ items: [{ productId: 'missing', quantity: 1 }] })).statusCode, 400);
  assert.equal(variantStock('cookie'), 5, 'nothing reserved');
  assert.equal(db.list('orders').length, 0);
});

test('createOrder refuses to oversell and leaves stock untouched', async () => {
  const res = await placeOrder({ items: [{ productId: 'ghee', selectedWeight: '500ml', quantity: 3 }] });
  assert.notEqual(res.statusCode, 201);
  assert.equal(variantStock('ghee'), 2);
  assert.equal(db.list('stockReservations').length, 0);
});

test('createOrder blocks a duplicate checkout with the same idempotency key', async () => {
  const items = [{ productId: 'cookie', selectedWeight: '120g', quantity: 1 }];
  assert.equal((await placeOrder({ items }, { 'idempotency-key': 'k1' })).statusCode, 201);
  assert.equal((await placeOrder({ items }, { 'idempotency-key': 'k1' })).statusCode, 409);
  assert.equal(variantStock('cookie'), 4, 'only the first checkout reserved stock');
});

test('createOrder releases the reservation when Razorpay is unavailable', async () => {
  razorpayBehaviour.createOrder = async () => { throw new Error('gateway down'); };
  const res = await placeOrder({ items: [{ productId: 'cookie', selectedWeight: '120g', quantity: 2 }] });
  assert.equal(res.statusCode, 502);
  assert.equal(variantStock('cookie'), 5, 'stock returned');
  assert.equal(db.list('stockReservations')[0].status, 'RELEASED');
});

// ── payment verification (browser callback) ─────────────────────────────────

async function pendingOrder() {
  const res = await placeOrder({ items: [{ productId: 'cookie', selectedWeight: '120g', quantity: 1 }] });
  return { orderId: res.body.orderId, rzpOrderId: res.body.razorpayOrderId };
}

async function verify(body, user = USER) {
  const res = mockRes();
  await orders.verifyRazorpay({ body, user, id: 'req' }, res);
  return res;
}

test('verifyRazorpay rejects a forged signature and leaves the order unpaid', async () => {
  const { orderId, rzpOrderId } = await pendingOrder();
  const res = await verify({ orderId, razorpay_order_id: rzpOrderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'f'.repeat(64) });
  assert.equal(res.statusCode, 400);
  assert.equal(db.read(`orders/${orderId}`).status, 'payment_pending');
});

test('verifyRazorpay confirms a correctly signed payment and locks in the reservation', async () => {
  const { orderId, rzpOrderId } = await pendingOrder();
  const signature = sign(process.env.RAZORPAY_KEY_SECRET, `${rzpOrderId}|pay_1`);
  const res = await verify({ orderId, razorpay_order_id: rzpOrderId, razorpay_payment_id: 'pay_1', razorpay_signature: signature });

  assert.equal(res.statusCode, 200);
  const order = db.read(`orders/${orderId}`);
  assert.equal(order.status, 'pending', 'paid + in stock');
  assert.equal(order.razorpayPaymentId, 'pay_1');
  assert.equal(db.read(`stockReservations/${order.reservationId}`).status, 'CONFIRMED');
});

test("verifyRazorpay won't confirm another customer's order", async () => {
  const { orderId, rzpOrderId } = await pendingOrder();
  const signature = sign(process.env.RAZORPAY_KEY_SECRET, `${rzpOrderId}|pay_1`);
  const res = await verify(
    { orderId, razorpay_order_id: rzpOrderId, razorpay_payment_id: 'pay_1', razorpay_signature: signature },
    { uid: 'intruder', role: 'customer' },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(db.read(`orders/${orderId}`).status, 'payment_pending');
});

test("verifyRazorpay won't confirm an order with a payment made for a different order", async () => {
  const cheap = await pendingOrder();
  const dear = await pendingOrder();
  // Genuine signature — but for the cheap order's Razorpay order.
  const signature = sign(process.env.RAZORPAY_KEY_SECRET, `${cheap.rzpOrderId}|pay_cheap`);
  const res = await verify({ orderId: dear.orderId, razorpay_order_id: cheap.rzpOrderId, razorpay_payment_id: 'pay_cheap', razorpay_signature: signature });
  assert.equal(res.statusCode, 400);
  assert.equal(db.read(`orders/${dear.orderId}`).status, 'payment_pending');
});

test('customers never see our courier cost, quoted courier or packing data', async () => {
  const { orderId } = await pendingOrder();
  db.seed(`orders/${orderId}`, {
    ...db.read(`orders/${orderId}`),
    estimatedShippingCost: 58, quotedCourier: { courierId: 2, name: 'C2', rate: 58 }, plannedPackage: { boxId: 'BX-S' },
    shipment: { provider: 'shiprocket', state: 'awb_assigned', awb: 'AWB9', courierName: 'C2', freightEstimate: 58, package: { boxId: 'BX-S' } },
  });
  const res = mockRes();
  await orders.getOrderById({ params: { id: orderId }, user: USER, id: 'req' }, res);
  const o = res.body.data;
  assert.equal(res.statusCode, 200);
  for (const k of ['estimatedShippingCost', 'quotedCourier', 'plannedPackage']) assert.equal(o[k], undefined, k);
  assert.equal(o.shipment.awb, 'AWB9');
  assert.equal(o.shipment.freightEstimate, undefined);
  assert.equal(o.shipment.package, undefined);
});

// ── Razorpay webhook ─────────────────────────────────────────────────────────

async function webhook(payload, { signature, eventId } = {}) {
  const raw = Buffer.from(JSON.stringify(payload));
  const res = mockRes();
  await orders.razorpayWebhook({
    body: raw,
    headers: {
      'x-razorpay-signature': signature ?? sign(process.env.RAZORPAY_WEBHOOK_SECRET, raw),
      ...(eventId ? { 'x-razorpay-event-id': eventId } : {}),
    },
    id: 'req',
  }, res);
  return res;
}

const captured = (rzpOrderId, paymentId = 'pay_w1') => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: rzpOrderId, status: 'captured' } } },
});

test('webhook rejects a bad signature', async () => {
  const { orderId, rzpOrderId } = await pendingOrder();
  const res = await webhook(captured(rzpOrderId), { signature: 'a'.repeat(64) });
  assert.equal(res.statusCode, 400);
  assert.equal(db.read(`orders/${orderId}`).status, 'payment_pending');
});

test('webhook payment.captured confirms the order exactly once', async () => {
  const { orderId, rzpOrderId } = await pendingOrder();
  assert.equal((await webhook(captured(rzpOrderId), { eventId: 'evt_1' })).statusCode, 200);
  assert.equal(db.read(`orders/${orderId}`).status, 'pending');

  const replay = await webhook(captured(rzpOrderId), { eventId: 'evt_1' });
  assert.equal(replay.statusCode, 200);
  assert.match(String(replay.body), /Duplicate/);
});

// ── stock reservation expiry ─────────────────────────────────────────────────

test('expired unpaid reservations return stock and cancel the order', async () => {
  const { orderId } = await pendingOrder();
  const order = db.read(`orders/${orderId}`);
  db.seed(`stockReservations/${order.reservationId}`, {
    ...db.read(`stockReservations/${order.reservationId}`),
    expiresAt: new Date(Date.now() - 60 * 1000),
  });
  assert.equal(variantStock('cookie'), 4);

  await orders.cleanupExpiredReservations();

  assert.equal(variantStock('cookie'), 5, 'stock released');
  assert.equal(db.read(`stockReservations/${order.reservationId}`).status, 'EXPIRED');
  assert.equal(db.read(`orders/${orderId}`).status, 'cancelled');
});

test('expiry cleanup confirms instead of cancelling when Razorpay shows it was paid', async () => {
  const { orderId, rzpOrderId } = await pendingOrder();
  const order = db.read(`orders/${orderId}`);
  db.seed(`stockReservations/${order.reservationId}`, {
    ...db.read(`stockReservations/${order.reservationId}`),
    expiresAt: new Date(Date.now() - 60 * 1000),
  });
  razorpayBehaviour.fetchPayments = async (id) => ({ items: id === rzpOrderId ? [{ id: 'pay_late', status: 'captured' }] : [] });

  await orders.cleanupExpiredReservations();

  assert.equal(db.read(`orders/${orderId}`).status, 'pending');
  assert.equal(variantStock('cookie'), 4, 'stock stays sold');
});

// ── admin delete ─────────────────────────────────────────────────────────────

test('deleteOrder refuses active paid orders and deletes closed ones', async () => {
  db.seed('orders/paid', { status: 'pending', totalAmount: 100, items: [] });
  db.seed('orders/done', { status: 'cancelled', totalAmount: 100, items: [] });
  const admin = { uid: 'a1', role: 'admin', email: 'admin@example.com' };

  const r1 = mockRes();
  await orders.deleteOrder({ params: { id: 'paid' }, user: admin, id: 'req' }, r1);
  assert.equal(r1.statusCode, 409);
  assert.ok(db.read('orders/paid'));

  const r2 = mockRes();
  await orders.deleteOrder({ params: { id: 'done' }, user: admin, id: 'req' }, r2);
  assert.equal(r2.statusCode, 200);
  assert.equal(db.read('orders/done'), undefined);
});
