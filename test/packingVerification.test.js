/**
 * Shipping-cost optimisation: packaging estimation (weight, volumetric,
 * flyers vs boxes, confidence), historical learning, packing verification,
 * the freight-difference policy, courier choice at dispatch, idempotent AWB
 * booking, local partners, legacy orders and analytics.
 * Shiprocket HTTP is stubbed per test; Firestore is the in-memory fake.
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, mockRes, razorpayBehaviour } = require('./helpers/setup');
const shiprocket = require('../services/shiprocketService');
const shipping = require('../services/shippingService');
const delivery = require('../services/deliveryService');
const pkg = require('../services/packageService');
const stats = require('../services/packingStatsService');
const packing = require('../services/packingVerificationService');
const model = require('../models/orderShipping');

const SR_ENV = {
  SHIPROCKET_EMAIL: 'api@example.com',
  SHIPROCKET_PASSWORD: 'x',
  SHIPROCKET_PICKUP_LOCATION: 'Primary',
  SHIPROCKET_PICKUP_PINCODE: '600001',
};
const original = { ...shiprocket };
const stub = (o) => Object.assign(shiprocket, o);
let pin = 610100;

beforeEach(() => {
  db.reset();
  pkg._resetCacheForTests();
  stats.invalidate();
  delivery.invalidateSettingsCache();
  delivery._clearServiceCache();
  Object.assign(process.env, SR_ENV);
  delete process.env.SHIPROCKET_AUTO_CREATE;
  pin += 1;
});
afterEach(() => {
  Object.assign(shiprocket, original);
  for (const k of Object.keys(SR_ENV)) process.env[k] = '';
});

const settings = (raw = {}) => pkg.normaliseSettings(raw);
const courier = (id, { rate = 60, days = 4, surface = true } = {}) => ({
  courierId: id, name: `C${id}`, rate, etd: null, estimatedDays: days, rating: 4, isSurface: surface,
});
const ESTIMATE = { deadKg: 0.7, volumetricKg: 0.7, chargeableKg: 0.7, length: 22, breadth: 16, height: 10, packageId: 'BX-M', packageType: 'box' };

/** A paid order placed with the new logistics record (checkout freight ₹80, fee ₹100). */
const paidOrder = (extra = {}) => ({
  status: 'pending',
  deliveryMethod: 'standard',
  deliveryPartner: 'shiprocket',
  deliveryFee: 100,
  shipping: 100,
  paidAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  createdAt: new Date(),
  customerInfo: { firstName: 'A', address: '1 St', city: 'Chennai', state: 'Tamil Nadu', pincode: String(pin), phone: '9876543210', email: 'a@x.in' },
  items: [{ productId: 'p', name: 'Ragi', category: 'Millets', selectedWeight: '500g', quantity: 1, price: 100, shipWeightKg: 0.55, dims: { l: 16, b: 11, h: 5 } }],
  logistics: {
    version: 1,
    customerFee: 100,
    estimate: ESTIMATE,
    checkoutQuote: { method: 'standard', courierId: 2, courierName: 'C2', freight: 80, fee: 100, quotedAt: '2026-11-01T00:00:00Z' },
    verification: { status: 'pending' },
    adjustment: { status: 'none' },
    verifications: [],
    overrides: [],
  },
  ...extra,
});

/** Shiprocket stub: freight depends on the parcel weight; dispatch quote via srOrderId. */
function shiprocketStub({ freightFor = (kg) => (kg > 0.8 ? 95 : 80), dispatchRate = 95, couriers, onAssign } = {}) {
  const list = (rate) => couriers || [courier(2, { rate }), courier(5, { rate: rate + 40 })];
  const calls = { created: [], assigned: [] };
  stub({
    checkServiceability: async (q) => {
      const rate = q.srOrderId ? dispatchRate : freightFor(Number(q.weightKg));
      return { serviceable: true, couriers: list(rate), recommendedId: 5 };
    },
    createOrder: async (_id, _o, p) => { calls.created.push(p); return { srOrderId: 11, shipmentId: 111, srStatus: 'NEW', weightKg: p.weightKg }; },
    assignAwb: async (_s, cid) => {
      calls.assigned.push(cid);
      if (onAssign) await onAssign();
      return { awb: `AWB${calls.assigned.length}`, courierId: cid, courierName: `C${cid}` };
    },
    generatePickup: async () => ({ scheduledDate: '2026-11-09' }),
    generateLabel: async () => 'https://label',
  });
  return calls;
}

const MEASURED = { weightKg: 0.9, length: 22, breadth: 16, height: 10, packageId: 'BX-M' };

// ── 1–8: estimation ─────────────────────────────────────────────────────────

test('1. single 500 g product without packed data: label weight + pouch allowance, flagged low confidence', () => {
  const p = pkg.buildPackage([{ quantity: 1, selectedWeight: '500g' }], settings());
  assert.equal(p.contentsKg, 0.53); // 0.5 × 1.05
  assert.equal(p.boxId, 'BX-M'); // 0.605 kg + safety exceeds Small's 0.6 kg limit
  assert.equal(p.confidence, 'low');
  assert.ok(p.warnings.some((w) => /weight only/.test(w)));
  assert.ok(p.breakdown.safetyKg >= 0.01);
});

test('2. single 1 kg product with packed weight + size: high confidence, chargeable = dead weight', () => {
  const p = pkg.buildPackage([{ quantity: 1, selectedWeight: '1kg', shipWeightKg: 1.03, dims: { l: 20, b: 14, h: 7 } }], settings());
  assert.equal(p.boxId, 'BX-M');
  assert.equal(p.weightKg, 1.2); // (1.03 + 0.11 tare + 0.02 tape) × 1.03
  assert.equal(p.chargeableKg, 1.2);
  assert.equal(p.confidence, 'high');
});

test('3. several light packs: volume decides, inner packaging per category is added', () => {
  const items = [{ quantity: 4, category: 'Cookies', shipWeightKg: 0.14, dims: { l: 14, b: 10, h: 4 } }];
  const plain = pkg.buildPackage(items, settings());
  assert.equal(plain.boxId, 'BX-M'); // 4 × 560 cm³ × 1.15 > Small's 1440 cm³
  const wrapped = pkg.buildPackage(items, settings({ categoryInnerPackagingKg: { cookies: 0.02 } }));
  assert.equal(wrapped.breakdown.innerKg, 0.08);
  assert.ok(wrapped.weightKg > plain.weightKg);
});

test('4. bulky products: volumetric weight dominates and is what the courier bills', () => {
  const p = pkg.buildPackage([{ quantity: 3, shipWeightKg: 1, dims: { l: 25, b: 20, h: 10 } }], settings());
  assert.equal(p.boxId, 'BX-XL');
  assert.equal(p.volumetricKg, 3.63);
  assert.ok(p.volumetricKg > p.weightKg);
  assert.equal(p.chargeableKg, 3.63);
});

test('5. missing dimensions use the configured fallback size and are never treated as accurate', () => {
  const items = [{ quantity: 2, shipWeightKg: 0.2 }];
  const none = pkg.buildPackage(items, settings());
  assert.equal(none.confidence, 'low');
  assert.ok(none.confidenceReasons.some((r) => /unknown dimensions/.test(r)));

  const fb = pkg.buildPackage(items, settings({ fallbackItemDims: { l: 15, b: 10, h: 5 } }));
  assert.equal(fb.confidence, 'low');
  assert.ok(fb.warnings.some((w) => /fallback size/.test(w)));
  assert.equal(fb.boxId, 'BX-M'); // 2 × 750 cm³ × 1.15 no longer fits Small
});

test('6. explicit packed weight beats the label weight', () => {
  const p = pkg.buildPackage([{ quantity: 1, selectedWeight: '500g', shipWeightKg: 0.58, dims: { l: 14, b: 10, h: 4 } }], settings());
  assert.equal(p.contentsKg, 0.58);
  assert.equal(p.confidence, 'high');
});

const FLYERS_ON = { boxes: pkg.DEFAULT_BOXES.map((b) => ({ ...b, isActive: true })) };

test('7. a flat pouch ships in a courier flyer when that bills a lower slab than a box', () => {
  const p = pkg.buildPackage([{ quantity: 1, shipWeightKg: 0.3, dims: { l: 20, b: 15, h: 2 } }], settings(FLYERS_ON));
  assert.equal(p.packageType, 'flyer');
  assert.equal(p.boxId, 'FL-S');
  assert.equal(p.chargeableKg, 0.4); // 25×20×4 / 5000; a box (Medium) would bill 0.7 kg
});

test('8. box-only categories (jars, glass) never go in a flyer', () => {
  const item = { quantity: 1, category: 'Honey', shipWeightKg: 0.3, dims: { l: 20, b: 15, h: 2 } };
  const p = pkg.buildPackage([item], settings({ ...FLYERS_ON, boxOnlyCategories: ['honey'] }));
  assert.equal(p.packageType, 'box');
  const flagged = pkg.buildPackage([{ ...item, category: 'Any', requiresBox: true }], settings(FLYERS_ON));
  assert.equal(flagged.packageType, 'box');
  // A flyer is never assumed to fit unknown item sizes either.
  const unknown = pkg.buildPackage([{ quantity: 1, shipWeightKg: 0.3 }], settings(FLYERS_ON));
  assert.equal(unknown.packageType, 'box');
});

test('packages are ranked by expected cost (freight + material) when courier rates are known', () => {
  const s = settings({ boxes: [
    { id: 'BX-M', length: 22, breadth: 16, height: 10, boxWeightKg: 0.11, maxWeightKg: 1.5, materialCost: 20 },
    { id: 'BX-L', length: 30, breadth: 22, height: 14, boxWeightKg: 0.18, maxWeightKg: 3.5, materialCost: 5 },
  ] });
  const items = [{ quantity: 1, shipWeightKg: 0.3, dims: { l: 14, b: 10, h: 4 } }];
  assert.equal(pkg.buildPackage(items, s).boxId, 'BX-M', 'no rates → lower billing slab wins');
  const rate = (kg) => (pkg.slabOf(kg) <= 1 ? 60 : 70);
  const ranked = pkg.buildPackage(items, s, null, { rateForKg: rate });
  assert.equal(ranked.boxId, 'BX-L'); // 70 + ₹5 < 60 + ₹20
  assert.equal(ranked.estimatedFreight, 70);
});

// ── historical learning ─────────────────────────────────────────────────────

test('learning: robust percentile, ignores one outlier, needs enough samples, admin override wins', () => {
  const diffs = [0.1, 0.11, 0.12, 0.1, 0.09, 0.1, 0.11, 0.1, 2.5];
  const a = stats.computeAllowance(diffs, { percentile: 75, maxAllowanceKg: 0.3 });
  assert.equal(a.trimmed, 1, 'the 2.5 kg outlier is dropped');
  assert.ok(a.allowanceKg >= 0.1 && a.allowanceKg <= 0.12);

  const learning = settings().learning;
  const map = { 'cookies#1|BX-S': { allowanceKg: 0.12, samples: 3 } };
  assert.equal(pkg.learnedAllowanceFor(map, 'cookies#1', 'BX-S', learning).kg, 0, 'below minSamples');
  map['cookies#1|BX-S'].samples = 8;
  assert.equal(pkg.learnedAllowanceFor(map, 'cookies#1', 'BX-S', learning).kg, 0.12);
  map['cookies#1|BX-S'].overrideKg = 0.05;
  assert.equal(pkg.learnedAllowanceFor(map, 'cookies#1', 'BX-S', learning).source, 'override');
  assert.equal(pkg.learnedAllowanceFor({ k: { overrideKg: 9 } }, 'x', null, learning).kg, 0, 'unknown key → 0');
  assert.equal(pkg.learnedAllowanceFor({ 'x|*': { overrideKg: 9 } }, 'x', 'BX-S', learning).kg, 0.3, 'clamped to max');
});

test('verified packings feed the learner, which then raises future estimates', async () => {
  const s = settings();
  for (let i = 0; i < 6; i += 1) {
    await stats.recordSample({ signature: 'millets#1', boxId: 'BX-M', baseEstimateKg: 0.7, actualKg: 0.82, orderId: `o${i}` }, s.learning);
  }
  const learned = await stats.getLearnedMap({ fresh: true });
  assert.equal(learned['millets#1|BX-M'].samples, 6);
  assert.equal(learned['millets#1|BX-M'].allowanceKg, 0.12);
  const items = [{ quantity: 1, category: 'Millets', shipWeightKg: 0.55, dims: { l: 16, b: 11, h: 5 } }];
  const before = pkg.buildPackage(items, s, { boxId: 'BX-M' }, { learned: {} });
  const after = pkg.buildPackage(items, s, { boxId: 'BX-M' }, { learned });
  assert.equal(after.breakdown.learnedKg, 0.12);
  assert.ok(after.weightKg > before.weightKg);
});

// ── 9–10: verification and the difference policy ───────────────────────────

test('9. actual weight above the estimate: recorded, compared, within tolerance → dispatch allowed', async () => {
  db.seed('orders/o1', paidOrder());
  shiprocketStub();
  const r = await packing.verifyPacking('o1', MEASURED, { by: 'staff@x.in' });
  const lg = r.logistics;
  assert.equal(lg.verification.status, 'verified');
  assert.equal(lg.estimate.deadKg, 0.7, 'the checkout estimate is never overwritten');
  assert.equal(lg.actual.deadKg, 0.9);
  assert.equal(lg.actual.chargeableKg, 0.9);
  assert.equal(lg.difference.deadKg, 0.2);
  assert.equal(lg.difference.freightRs, 15); // ₹95 − ₹80
  assert.equal(lg.adjustment.status, 'within_tolerance');
  assert.equal(lg.verifications.length, 1);
  assert.equal(r.dispatch.allowed, true);
});

test('10. bigger actual box: volumetric difference is measured and a large freight jump needs approval', async () => {
  db.seed('orders/o1', paidOrder());
  shiprocketStub({ freightFor: () => 140 });
  const r = await packing.verifyPacking('o1', { weightKg: 0.75, length: 30, breadth: 22, height: 14, packageId: 'BX-L' }, { by: 's' });
  assert.equal(r.logistics.actual.volumetricKg, 1.85);
  assert.equal(r.logistics.difference.volumetricKg, 1.15);
  assert.equal(r.logistics.adjustment.status, 'needs_approval');
  assert.equal(r.dispatch.allowed, false);
  await assert.rejects(shipping.createShipmentForOrder('o1'), { code: 'ADJUSTMENT_PENDING' });

  // Admin decides: customer contacted keeps it blocked; approve releases it.
  await packing.decideAdjustment('o1', { decision: 'customer_contacted', note: 'called' }, { by: 'admin' });
  await assert.rejects(shipping.createShipmentForOrder('o1'), { code: 'ADJUSTMENT_PENDING' });
  await packing.decideAdjustment('o1', { decision: 'approve', note: 'absorb' }, { by: 'admin' });
  const sh = await shipping.createShipmentForOrder('o1');
  assert.equal(sh.package.source, 'verified');
  // Never a second charge: the fee on the order is unchanged.
  assert.equal(db.read('orders/o1').deliveryFee, 100);
});

test('small differences are absorbed automatically', () => {
  const policy = settings().adjustment;
  assert.equal(model.adjustmentFor(-5, policy).status, 'none');
  assert.equal(model.adjustmentFor(8, policy).status, 'absorbed');
  assert.equal(model.adjustmentFor(20, policy).status, 'within_tolerance');
  assert.equal(model.adjustmentFor(40, policy).status, 'needs_approval');
});

test('booking is refused until the parcel is measured; Shiprocket then gets the ACTUAL parcel', async () => {
  db.seed('orders/o1', paidOrder());
  const calls = shiprocketStub();

  await shipping.autoCreateShipment('o1');
  assert.equal(calls.created.length, 0, 'automatic push waits for packing verification');
  await assert.rejects(shipping.shipOrder('o1'), { code: 'PACKING_NOT_VERIFIED' });

  await packing.verifyPacking('o1', MEASURED, { by: 's' });
  const { shipment } = await shipping.shipOrder('o1');
  assert.deepEqual(
    [calls.created[0].weightKg, calls.created[0].length, calls.created[0].breadth, calls.created[0].height],
    [0.9, 22, 16, 10],
  );
  assert.equal(shipment.awb, 'AWB1');
  assert.equal(calls.assigned[0], 2, 'checkout courier preferred');
  assert.equal(shipment.courierPick, 'checkout_courier');
  const lg = db.read('orders/o1').logistics;
  assert.equal(lg.actualFreight, 95);
  assert.equal(lg.freightDifferenceRs, 15);
  assert.equal(lg.marginRs, 5); // ₹100 fee − ₹95 freight − ₹0 material
});

test('a dispatch-time price jump above tolerance blocks booking until approved', async () => {
  db.seed('orders/o1', paidOrder());
  const calls = shiprocketStub({ dispatchRate: 150 });
  await packing.verifyPacking('o1', MEASURED, { by: 's' });
  await assert.rejects(shipping.shipOrder('o1'), { code: 'ADJUSTMENT_PENDING' });
  assert.equal(calls.assigned.length, 0);
  assert.equal(db.read('orders/o1').logistics.adjustment.stage, 'dispatch');
  assert.equal(db.read('orders/o1').shipment.awbClaimAt, undefined, 'claim released');
  await packing.decideAdjustment('o1', { decision: 'approve' }, { by: 'admin' });
  const { shipment } = await shipping.shipOrder('o1');
  assert.equal(shipment.awb, 'AWB1');
});

// ── 11–14: courier choice, failures, local partner, duplicates ─────────────

test('11. checkout courier unavailable at dispatch → next courier in the same delivery category', async () => {
  db.seed('orders/s', paidOrder());
  const std = shiprocketStub({ couriers: [courier(7, { rate: 85 }), courier(8, { rate: 82 })] });
  await packing.verifyPacking('s', MEASURED, { by: 's' });
  const a = await shipping.shipOrder('s');
  assert.equal(std.assigned[0], 8);
  assert.equal(a.shipment.courierPick, 'cheapest_fallback');

  const fast = { courierId: 3, name: 'C3', rate: 150 };
  db.seed('orders/f', paidOrder({
    deliveryMethod: 'fastest',
    logistics: { ...paidOrder().logistics, checkoutQuote: { ...paidOrder().logistics.checkoutQuote, method: 'fastest', courierId: 3, freight: 150 } },
  }));
  const cs = [courier(1, { rate: 60 }), courier(4, { surface: false, days: 1, rate: 160 }), courier(6, { surface: false, days: 2, rate: 140 })];
  const fc = shiprocketStub({ couriers: cs });
  await packing.verifyPacking('f', MEASURED, { by: 's' });
  const b = await shipping.shipOrder('f');
  assert.equal(fc.assigned[0], 4, 'fastest stays on an express courier');
  assert.equal(b.shipment.courierPick, 'express_fallback');
  assert.ok(fast);
});

test('11b. a staff-chosen courier that no longer serves the shipment is refused', async () => {
  db.seed('orders/o1', paidOrder());
  shiprocketStub();
  await packing.verifyPacking('o1', MEASURED, { by: 's' });
  await assert.rejects(shipping.shipOrder('o1', { courierId: 999 }), { code: 'COURIER_UNAVAILABLE' });
});

test('12. Shiprocket outage: verification still records the parcel; a failed push is flagged, not lost', async () => {
  db.seed('orders/o1', paidOrder());
  stub({
    checkServiceability: async () => { throw new shiprocket.ShiprocketError('HTTP 503', { status: 503 }); },
    createOrder: async () => { throw new shiprocket.ShiprocketError('HTTP 503', { status: 503 }); },
  });
  const r = await packing.verifyPacking('o1', MEASURED, { by: 's' });
  assert.equal(r.logistics.actual.freightQuote, null);
  assert.equal(r.logistics.freightNote, 'quote_failed');
  assert.equal(r.logistics.adjustment.status, 'none');
  await assert.rejects(shipping.createShipmentForOrder('o1'), /503/);
  assert.equal(db.read('orders/o1').shipment.state, 'failed');
});

test('13. local delivery PIN: verification not required, never pushed to Shiprocket automatically', async () => {
  const lg = model.buildInitialShipping({ pkg: null, quote: null, fee: 40, partner: 'local' });
  assert.equal(lg.verification.status, 'not_required');
  db.seed('orders/l', paidOrder({ deliveryPartner: 'local', logistics: lg }));
  const calls = shiprocketStub();
  await shipping.autoCreateShipment('l');
  assert.equal(calls.created.length, 0);
});

test('14. duplicate dispatch clicks assign exactly one AWB', async () => {
  db.seed('orders/o1', paidOrder());
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = shiprocketStub({ onAssign: () => gate });
  await packing.verifyPacking('o1', MEASURED, { by: 's' });
  await shipping.createShipmentForOrder('o1');
  const first = shipping.shipOrder('o1');
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(shipping.shipOrder('o1'), { code: 'BUSY' });
  release();
  await first;
  assert.equal(calls.assigned.length, 1);
  const again = await shipping.shipOrder('o1'); // idempotent once booked
  assert.equal(again.shipment.awb, 'AWB1');
  assert.equal(calls.assigned.length, 1);
  await assert.rejects(packing.verifyPacking('o1', MEASURED, { by: 's' }), { code: 'ALREADY_BOOKED' });
});

test('an order already pushed with estimated measurements needs the Shiprocket panel corrected first', async () => {
  db.seed('orders/o1', paidOrder({
    shipment: { provider: 'shiprocket', state: 'created', srOrderId: 9, shipmentId: 90, package: { boxId: 'BX-M', length: 22, breadth: 16, height: 10, weightKg: 0.7 } },
  }));
  shiprocketStub();
  const r = await packing.verifyPacking('o1', MEASURED, { by: 's' });
  assert.equal(r.logistics.pushedMismatch, true);
  await assert.rejects(shipping.shipOrder('o1'), { code: 'PUSHED_PACKAGE_MISMATCH' });
  await assert.rejects(packing.overridePacking('o1', { kind: 'panel_updated', reason: '' }, { by: 'admin' }), { code: 'BAD_OVERRIDE' });
  await packing.overridePacking('o1', { kind: 'panel_updated', reason: 'set 0.9 kg in panel' }, { by: 'admin' });
  const { shipment } = await shipping.shipOrder('o1');
  assert.equal(shipment.awb, 'AWB1');
});

test('admin can skip verification with a recorded reason', async () => {
  db.seed('orders/o1', paidOrder());
  shiprocketStub();
  const lg = await packing.overridePacking('o1', { kind: 'skip_verification', reason: 'scale broken, same box as always' }, { by: 'admin@x.in' });
  assert.equal(lg.verification.status, 'overridden');
  assert.equal(lg.overrides[0].by, 'admin@x.in');
  const { shipment } = await shipping.shipOrder('o1');
  assert.ok(shipment.awb);
});

test('the retry job leaves unmeasured orders alone and never burns their retries', async () => {
  db.seed('orders/o1', paidOrder({ shipment: { provider: 'shiprocket', state: 'failed' } }));
  const calls = shiprocketStub();
  const r = await shipping.retryFailedShipments();
  assert.equal(r.retried, 0);
  assert.equal(r.awaitingPacking, 1);
  assert.equal(calls.created.length, 0);
  assert.equal(db.read('orders/o1').shipment.retryCount, undefined);
});

// ── 15–16: payments and legacy orders ──────────────────────────────────────

test('15. Razorpay failure at checkout: no order, no shipment, stock released', async () => {
  const orders = require('../controllers/orderController');
  db.seed('products/c', { title: 'Cookie', category: 'Cookies', price: 90, stock: 3, variants: [{ weight: '120g', price: 90, stock: 3, shipWeightKg: 0.14, dims: { l: 14, b: 10, h: 4 } }] });
  db.seed('deliverySettings/global', { defaultDeliveryFee: 70, serviceByDefault: true });
  for (const k of Object.keys(SR_ENV)) process.env[k] = ''; // Shiprocket off → fallback fee
  const before = razorpayBehaviour.createOrder;
  razorpayBehaviour.createOrder = async () => { throw new Error('gateway down'); };
  try {
    const res = mockRes();
    await orders.createOrder({
      body: { items: [{ productId: 'c', selectedWeight: '120g', quantity: 1 }], customerInfo: { firstName: 'A', address: 'x', city: 'Chennai', state: 'TN', pincode: '600001', phone: '9876543210' } },
      user: { uid: 'u1', email: 'u@x.in', role: 'customer' }, headers: {}, id: 'r',
    }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(db.read('products/c').variants[0].stock, 3);
  } finally {
    razorpayBehaviour.createOrder = before;
  }
});

test('new orders snapshot the estimate + checkout quote; customers never see logistics', async () => {
  const orders = require('../controllers/orderController');
  db.seed('products/c', { title: 'Cookie', category: 'Cookies', price: 90, stock: 3, variants: [{ weight: '120g', price: 90, stock: 3, shipWeightKg: 0.14, dims: { l: 14, b: 10, h: 4 } }] });
  db.seed('deliverySettings/global', { defaultDeliveryFee: 70, serviceByDefault: true });
  for (const k of Object.keys(SR_ENV)) process.env[k] = '';
  const user = { uid: 'u1', email: 'u@x.in', role: 'customer' };
  const res = mockRes();
  await orders.createOrder({
    body: { items: [{ productId: 'c', selectedWeight: '120g', quantity: 2 }], customerInfo: { firstName: 'A', address: 'x', city: 'Chennai', state: 'TN', pincode: '600001', phone: '9876543210' } },
    user, headers: {}, id: 'r',
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const o = db.read(`orders/${res.body.orderId}`);
  assert.equal(o.shipping, 70, 'legacy numeric fee untouched');
  assert.equal(o.logistics.customerFee, 70);
  assert.equal(o.logistics.estimate.confidence, 'high');
  assert.ok(o.logistics.estimate.chargeableKg > 0);
  assert.equal(o.logistics.checkoutQuote.source, 'fallback');
  assert.ok(o.logistics.checkoutQuote.quotedAt);
  assert.equal(o.logistics.verification.status, 'pending');

  const view = mockRes();
  await orders.getOrderById({ params: { id: res.body.orderId }, user, id: 'r' }, view);
  assert.equal(view.statusCode, 200);
  assert.equal(view.body.data.logistics, undefined);
});

test('16. orders placed before this change: estimate rebuilt (flagged) and legacy quote used', async () => {
  const legacy = paidOrder({ quotedCourier: { courierId: 2, name: 'C2', rate: 80 }, estimatedShippingCost: 80 });
  delete legacy.logistics;
  db.seed('orders/old', legacy);
  shiprocketStub();
  const r = await packing.verifyPacking('old', MEASURED, { by: 's' });
  assert.equal(r.logistics.estimate.reconstructed, true);
  assert.equal(r.logistics.difference.freightRs, 15);
  assert.equal(r.logistics.customerFee, 100);
});

test('measurement input is validated', async () => {
  db.seed('orders/o1', paidOrder());
  shiprocketStub();
  await assert.rejects(packing.verifyPacking('o1', { weightKg: 0.9, length: 22 }, {}), { code: 'BAD_MEASUREMENT' });
  await assert.rejects(packing.verifyPacking('o1', { ...MEASURED, packageId: 'NOPE' }, {}), { code: 'BAD_PACKAGE' });
  await assert.rejects(packing.verifyPacking('o1', { ...MEASURED, materialCost: -1 }, {}), { code: 'BAD_MEASUREMENT' });
});

// ── pricing + analytics ────────────────────────────────────────────────────

test('handling charge and freight buffer are applied to the courier-linked fee', async () => {
  db.seed('deliverySettings/global', { serviceByDefault: true, handlingFee: 10, freightBufferPct: 10 });
  stub({ checkServiceability: async () => ({ serviceable: true, couriers: [courier(2, { rate: 62.5 })], recommendedId: 2 }) });
  const d = await delivery.computeDeliveryFee({ pincode: String(pin), subtotal: 200 });
  assert.equal(d.fee, 90); // 62.5 × 1.1 = 68.75 → ₹80 band + ₹10 handling
  assert.equal(d.quote.handlingFee, 10);
  assert.equal(d.quote.freight, 62.5);
});

test('identical quote requests hit the cache, not Shiprocket', async () => {
  let calls = 0;
  stub({ checkServiceability: async () => { calls += 1; return { serviceable: true, couriers: [courier(2)], recommendedId: 2 }; } });
  await delivery.courierRateFor(String(pin), 0.7);
  await delivery.courierRateFor(String(pin), 0.9); // same 1 kg slab
  assert.equal(calls, 1);
});

test('analytics: revenue, freight, profit/loss, courier + package breakdown and the review queue', async () => {
  db.seed('orders/a', paidOrder());
  db.seed('orders/b', paidOrder());
  shiprocketStub();
  await packing.verifyPacking('a', MEASURED, { by: 's' });
  await shipping.shipOrder('a');
  shiprocketStub({ freightFor: () => 140 });
  await packing.verifyPacking('b', MEASURED, { by: 's' });

  const a = await packing.shippingAnalytics({ days: 7 });
  assert.equal(a.totals.orders, 2);
  assert.equal(a.totals.shipped, 1);
  assert.equal(a.totals.revenue, 200);
  assert.equal(a.totals.actualFreight, 235); // 95 booked + 140 quoted
  assert.equal(a.totals.losses, 40);
  assert.equal(a.avgWeightDiffKg, 0.2);
  assert.ok(a.couriers.some((c) => c.key === 'C2'));
  assert.equal(a.review.length, 1);
  assert.equal(a.review[0].orderId, 'b');
});

test('saving settings from an older admin screen keeps fields it did not send', async () => {
  await pkg.savePackagingSettings({ boxes: [{ id: 'FL-S', type: 'flyer', length: 25, breadth: 20, height: 4, materialCost: 4 }], safetyPct: 5 }, { by: 'a' });
  // Old client: no type / materialCost / safetyPct in the payload.
  const saved = await pkg.savePackagingSettings({ boxes: [{ id: 'fl-s', name: 'Flyer', length: 26, breadth: 20, height: 4 }] }, { by: 'a' });
  assert.equal(saved.boxes[0].type, 'flyer');
  assert.equal(saved.boxes[0].materialCost, 4);
  assert.equal(saved.boxes[0].length, 26);
  assert.equal(saved.safetyPct, 5);
});
