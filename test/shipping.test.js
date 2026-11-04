/**
 * Shiprocket fulfilment rules: delivery partner routing, courier-checked PIN
 * rules, courier-linked fees, express couriers for "fastest", RTO / NDR
 * handling, cancel-on-refund and the failed-push retry job.
 * The Shiprocket HTTP client is stubbed per test.
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers/setup');
const shiprocket = require('../services/shiprocketService');
const shipping = require('../services/shippingService');
const delivery = require('../services/deliveryService');

const SR_ENV = {
  SHIPROCKET_EMAIL: 'api@example.com',
  SHIPROCKET_PASSWORD: 'x',
  SHIPROCKET_PICKUP_LOCATION: 'Primary',
  SHIPROCKET_PICKUP_PINCODE: '600001',
};
const original = { ...shiprocket };
let pin = 600100; // fresh PIN per test → no serviceability cache hits across tests

function stub(overrides) { Object.assign(shiprocket, overrides); }

beforeEach(() => {
  db.reset();
  Object.assign(process.env, SR_ENV);
  delete process.env.SHIPROCKET_AUTO_CREATE;
  delivery.invalidateSettingsCache();
  pin += 1;
});
afterEach(() => {
  Object.assign(shiprocket, original);
  for (const k of Object.keys(SR_ENV)) process.env[k] = '';
});

const courier = (id, { rate = 60, days = 4, surface = true } = {}) => ({
  courierId: id, name: `C${id}`, rate, etd: null, estimatedDays: days, rating: 4, isSurface: surface,
});
const quotes = (couriers, recommendedId = couriers[0]?.courierId) => async () => ({
  serviceable: couriers.length > 0, couriers, recommendedId: recommendedId ?? null,
});

const paidOrder = (extra = {}) => ({
  status: 'pending',
  deliveryMethod: 'standard',
  deliveryPartner: 'shiprocket',
  paidAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  customerInfo: { firstName: 'A', address: '1 St', city: 'Chennai', state: 'Tamil Nadu', pincode: '600002', phone: '9876543210', email: 'a@x.in' },
  items: [{ productId: 'p', name: 'Ragi', selectedWeight: '500g', quantity: 1, price: 100 }],
  ...extra,
});

// ── checkout: partner + courier check + fees ────────────────────────────────

test('a Shiprocket PIN with an admin rule is still blocked when no courier serves it', async () => {
  db.seed(`deliveryPincodes/${pin}`, { pincode: String(pin), deliveryAvailable: true, standardFeeType: 'custom', standardDeliveryFee: 30 });
  stub({ checkServiceability: quotes([]) });
  const o = await delivery.resolveDeliveryOptions({ pincode: String(pin), subtotal: 200 });
  assert.equal(o.deliveryAvailable, false);
  assert.match(o.reason, /courier/);
});

test('a local-partner PIN never asks Shiprocket and is deliverable', async () => {
  db.seed(`deliveryPincodes/${pin}`, { pincode: String(pin), deliveryAvailable: true, deliveryPartner: 'local' });
  let called = false;
  stub({ checkServiceability: async () => { called = true; return { serviceable: false, couriers: [] }; } });
  const o = await delivery.resolveDeliveryOptions({ pincode: String(pin), subtotal: 200 });
  assert.equal(called, false);
  assert.equal(o.deliveryAvailable, true);
  assert.equal(o.partner, 'local');
});

test('courier check uses the cart weight slab', async () => {
  let asked;
  stub({ checkServiceability: async (q) => { asked = q; return quotes([courier(1)])(); } });
  await delivery.resolveDeliveryOptions({ pincode: String(pin), subtotal: 100, weightKg: 2.3 });
  assert.equal(asked.weightKg, 2.5);
});

test('courier-linked fees pick the band for the freight quote; custom PIN fees still win', async () => {
  db.seed('deliverySettings/global', {
    defaultDeliveryFee: 50, freeDeliveryEnabled: false, serviceByDefault: true, courierLinkedFee: true,
    courierFeeBands: [{ maxRate: 50, fee: 40 }, { maxRate: 100, fee: 70 }, { maxRate: 0, fee: 150 }],
  });
  stub({ checkServiceability: quotes([courier(1, { rate: 85 })]) });
  const banded = await delivery.computeDeliveryFee({ pincode: String(pin), subtotal: 100 });
  assert.equal(banded.fee, 70);
  assert.equal(banded.estimatedShippingCost, 85);

  pin += 1;
  stub({ checkServiceability: quotes([courier(1, { rate: 400 })]) });
  assert.equal((await delivery.computeDeliveryFee({ pincode: String(pin), subtotal: 100 })).fee, 150);

  pin += 1;
  db.seed(`deliveryPincodes/${pin}`, { pincode: String(pin), deliveryAvailable: true, standardFeeType: 'custom', standardDeliveryFee: 25 });
  assert.equal((await delivery.computeDeliveryFee({ pincode: String(pin), subtotal: 100 })).fee, 25);
});

test('fastest is only offered where an express (non-surface) courier serves the PIN', async () => {
  db.seed('deliverySettings/global', { fastestDeliveryEnabled: true, serviceByDefault: true });
  stub({ checkServiceability: quotes([courier(1, { surface: true })]) });
  const surfaceOnly = await delivery.resolveDeliveryOptions({ pincode: String(pin), subtotal: 300 });
  assert.equal(surfaceOnly.fastest.available, false);

  pin += 1;
  stub({ checkServiceability: quotes([courier(1), courier(2, { surface: false, days: 1, rate: 120 })]) });
  const withAir = await delivery.resolveDeliveryOptions({ pincode: String(pin), subtotal: 300 });
  assert.equal(withAir.fastest.available, true);
  assert.equal(withAir.fastest.eta, '2–3 business days');
});

// ── fulfilment ──────────────────────────────────────────────────────────────

test('local-partner orders are not pushed automatically, but staff can force it', async () => {
  db.seed('orders/o1', paidOrder({ deliveryPartner: 'local' }));
  let pushed = 0;
  stub({ createOrder: async () => { pushed += 1; return { srOrderId: 9, shipmentId: 99, srStatus: 'NEW', weightKg: 0.6 }; } });

  await shipping.autoCreateShipment('o1');
  assert.equal(pushed, 0);
  await assert.rejects(shipping.createShipmentForOrder('o1'), { code: 'LOCAL_PARTNER' });

  const sh = await shipping.createShipmentForOrder('o1', { force: true });
  assert.equal(pushed, 1);
  assert.equal(sh.shipmentId, 99);
});

test('a fastest order is shipped with the express courier and its freight recorded', async () => {
  db.seed('orders/o2', paidOrder({ deliveryMethod: 'fastest', shipment: { provider: 'shiprocket', state: 'created', srOrderId: 7, shipmentId: 70 } }));
  let assignedTo;
  stub({
    checkServiceability: quotes([courier(1, { rate: 55 }), courier(2, { surface: false, days: 1, rate: 140 }), courier(3, { surface: false, days: 2, rate: 90 })]),
    assignAwb: async (_id, cid) => { assignedTo = cid; return { awb: 'AWB1', courierId: cid, courierName: `C${cid}` }; },
    generatePickup: async () => ({ scheduledDate: '2026-11-05' }),
    generateLabel: async () => 'https://label',
  });
  const { shipment } = await shipping.shipOrder('o2');
  assert.equal(assignedTo, 2);
  assert.equal(shipment.courierPick, 'express');
  assert.equal(shipment.freightEstimate, 140);
});

test('NDR flags the shipment once; RTO halts forward moves and alerts staff', async () => {
  db.seed('orders/o3', paidOrder({ status: 'shipped', shipment: { provider: 'shiprocket', state: 'in_transit', awb: 'A3' } }));

  const ndr = await shipping.applyTrackingUpdate('o3', { courierStatus: 'UNDELIVERED' });
  assert.equal(ndr.alert, 'ndr');
  assert.equal(db.read('orders/o3').shipment.ndr.count, 1);
  assert.equal(await shipping.applyTrackingUpdate('o3', { courierStatus: 'UNDELIVERED' }), null, 'same NDR scan → no repeat alert');

  const rto = await shipping.applyTrackingUpdate('o3', { courierStatus: 'RTO INITIATED' });
  assert.equal(rto.alert, 'rto');
  assert.equal(db.read('orders/o3').shipment.state, 'rto_in_transit');

  // A stray forward scan during RTO must not move the order to delivered.
  await shipping.applyTrackingUpdate('o3', { courierStatus: 'OUT FOR DELIVERY' });
  assert.equal(db.read('orders/o3').status, 'shipped');

  const back = await shipping.applyTrackingUpdate('o3', { courierStatus: 'RTO DELIVERED' });
  assert.equal(back.alert, 'rto_delivered');
  assert.equal(db.read('orders/o3').shipment.state, 'rto_delivered');
  assert.equal(db.read('orders/o3').status, 'shipped', 'order stays refundable');
});

test('delivery clears an NDR flag', async () => {
  db.seed('orders/o4', paidOrder({ status: 'out_for_delivery', shipment: { provider: 'shiprocket', state: 'in_transit', ndr: { status: 'UNDELIVERED', count: 1 } } }));
  const change = await shipping.applyTrackingUpdate('o4', { courierStatus: 'DELIVERED' });
  assert.equal(change.to, 'delivered');
  assert.equal(db.read('orders/o4').shipment.ndr, undefined);
});

test('cancel-on-refund cancels before pickup and refuses once the courier has it', async () => {
  let cancelled = null;
  stub({ cancelOrder: async (id) => { cancelled = id; return true; } });

  db.seed('orders/o5', paidOrder({ shipment: { provider: 'shiprocket', state: 'pickup_scheduled', srOrderId: 55 } }));
  assert.equal(await shipping.cancelShipmentForOrder('o5'), 'cancelled');
  assert.equal(cancelled, 55);
  assert.equal(db.read('orders/o5').shipment.state, 'cancelled');

  db.seed('orders/o6', paidOrder({ shipment: { provider: 'shiprocket', state: 'in_transit', srOrderId: 66 } }));
  assert.equal(await shipping.cancelShipmentForOrder('o6'), 'too_late');

  stub({ cancelOrder: async () => { throw new Error('boom'); } });
  db.seed('orders/o7', paidOrder({ shipment: { provider: 'shiprocket', state: 'created', srOrderId: 77 } }));
  assert.equal(await shipping.cancelShipmentForOrder('o7'), 'failed');
  assert.match(db.read('orders/o7').shipment.error, /cancel/i);
});

test('retry job re-pushes failed orders, then gives up after 3 attempts and alerts', async () => {
  db.seed('orders/ok', paidOrder({ shipment: { provider: 'shiprocket', state: 'failed', error: 'x' } }));
  db.seed('orders/bad', paidOrder({ customerInfo: { ...paidOrder().customerInfo, phone: '' }, shipment: { provider: 'shiprocket', state: 'failed', retryCount: 2 } }));
  db.seed('orders/local', paidOrder({ deliveryPartner: 'local' }));
  db.seed('orders/fresh', paidOrder({ paidAt: new Date().toISOString() }));
  let pushes = 0;
  stub({ createOrder: async () => { pushes += 1; return { srOrderId: 1, shipmentId: 11, srStatus: 'NEW', weightKg: 0.5 }; } });

  const gaveUp = [];
  const r = await shipping.retryFailedShipments({ onGiveUp: (id) => gaveUp.push(id) });
  assert.equal(r.retried, 2);
  assert.equal(r.succeeded, 1);
  assert.equal(pushes, 1);
  assert.equal(db.read('orders/ok').shipment.shipmentId, 11);
  assert.deepEqual(gaveUp, ['bad']);
  assert.equal(db.read('orders/bad').shipment.needsAttention, true);
  assert.equal(db.read('orders/bad').shipment.retryCount, 3);

  const again = await shipping.retryFailedShipments();
  assert.equal(again.retried, 0, 'flagged / local / fresh orders are skipped');
});

test('order items carry SKU, HSN and GST to Shiprocket', async () => {
  db.seed('orders/o8', paidOrder({ items: [{ productId: 'p', name: 'Ragi', selectedWeight: '500g', quantity: 2, price: 100, sku: 'ALM-RAGI-500', hsn: '1008', gstRate: 5 }] }));
  let payload;
  // Capture the real payload by stubbing the network layer below createOrder.
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/auth/login')) return new Response(JSON.stringify({ token: 't' }), { status: 200 });
    payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ order_id: 1, shipment_id: 2, status: 'NEW' }), { status: 200 });
  };
  try {
    await shipping.createShipmentForOrder('o8');
  } finally {
    global.fetch = realFetch;
  }
  assert.deepEqual(payload.order_items[0], { name: 'Ragi', sku: 'ALM-RAGI-500', units: 2, selling_price: 100, hsn: '1008', tax: 5 });
});

test('products validate SKU / HSN / GST and keep them on save', async () => {
  const { mockRes } = require('./helpers/setup');
  const products = require('../controllers/productController');
  const user = { uid: 'a', email: 'a@x.in', role: 'admin' };
  const base = { title: 'Ragi', category: 'Millets', description: 'd' };
  const make = async (body) => { const res = mockRes(); await products.createProduct({ body: { ...base, ...body }, user, id: 'r', ip: '::1' }, res); return res; };

  assert.equal((await make({ hsn: '12', variants: [{ weight: '1kg', price: 10, stock: 1 }] })).statusCode, 400);
  assert.equal((await make({ gstRate: 7, variants: [{ weight: '1kg', price: 10, stock: 1 }] })).statusCode, 400);
  assert.equal((await make({ variants: [{ weight: '1kg', price: 10, stock: 1, sku: 'A-1' }, { weight: '2kg', price: 20, stock: 1, sku: 'a-1' }] })).statusCode, 400);

  const ok = await make({ hsn: '1008', gstRate: '5', variants: [{ weight: '1kg', price: 10, stock: 1, sku: ' ALM-RAGI-1KG ' }] });
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.body));
  const saved = db.read(`products/${ok.body.id}`);
  assert.equal(saved.hsn, '1008');
  assert.equal(saved.gstRate, 5);
  assert.equal(saved.variants[0].sku, 'ALM-RAGI-1KG');
});

// ── login circuit breaker ───────────────────────────────────────────────────

function fakeNetwork(loginReply) {
  const calls = { login: 0, api: 0 };
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/auth/login')) {
      calls.login += 1;
      const r = loginReply(calls.login);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }
    calls.api += 1;
    return new Response(JSON.stringify({ data: { available_courier_companies: [] } }), { status: 200 });
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

test('a rejected login pauses all further logins instead of hammering Shiprocket', async () => {
  shiprocket._resetAuthForTests();
  const net = fakeNetwork(() => ({ status: 400, body: { message: 'Invalid email and password combination' } }));
  try {
    await assert.rejects(shiprocket.checkServiceability({ deliveryPincode: '600002' }), /login failed/);
    for (let i = 0; i < 20; i += 1) {
      await assert.rejects(shiprocket.checkServiceability({ deliveryPincode: '600002' }), /paused until/);
    }
    assert.equal(net.calls.login, 1, 'only ONE login attempt despite 21 requests');
    const st = shiprocket.authStatus();
    assert.equal(st.paused, true);
    assert.match(st.lastError, /Invalid email/);

    // Checkout keeps working (fails open) while paused.
    const o = await delivery.resolveDeliveryOptions({ pincode: String(pin), subtotal: 100 });
    assert.equal(o.deliveryAvailable, true);
    assert.equal(net.calls.login, 1);
  } finally {
    net.restore();
    shiprocket._resetAuthForTests();
  }
});

test('"user blocked" pauses for at least 30 min; the retry job waits it out', async () => {
  shiprocket._resetAuthForTests();
  const net = fakeNetwork(() => ({ status: 400, body: { message: 'User blocked due to too many failed login attempts.' } }));
  try {
    await assert.rejects(shiprocket.checkServiceability({ deliveryPincode: '600002' }));
    const until = Date.parse(shiprocket.authStatus().pausedUntil);
    assert.ok(until - Date.now() > 29 * 60 * 1000);

    db.seed('orders/r1', paidOrder({ shipment: { provider: 'shiprocket', state: 'failed' } }));
    const r = await shipping.retryFailedShipments();
    assert.equal(r.skipped, 'login_paused');
    assert.equal(db.read('orders/r1').shipment.retryCount, undefined, 'no retry burned');
  } finally {
    net.restore();
    shiprocket._resetAuthForTests();
  }
});

test('admin test-login clears the pause, recovers, and is rate-limited', async () => {
  shiprocket._resetAuthForTests();
  const net = fakeNetwork((n) => (n === 1
    ? { status: 400, body: { message: 'Invalid email and password combination' } }
    : { status: 200, body: { token: 'tok' } }));
  try {
    await assert.rejects(shiprocket.checkServiceability({ deliveryPincode: '600002' }));
    const st = await shiprocket.testLogin();
    assert.equal(st.ok, true);
    assert.equal(st.consecutiveFailures, 0);
    await shiprocket.checkServiceability({ deliveryPincode: '600002' });
    assert.equal(net.calls.login, 2);
    await assert.rejects(shiprocket.testLogin(), /Wait \d+ s/);
  } finally {
    net.restore();
    shiprocket._resetAuthForTests();
  }
});
