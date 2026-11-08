/**
 * orderShipping.js — shape, enums and builders for `order.logistics`, the
 * structured estimate-vs-actual shipping record on every order.
 *
 * The database is Firestore (schemaless), so this module is the "schema":
 * every write goes through these builders, which validate, clamp and default
 * values. Orders placed before this existed simply have no `order.logistics`;
 * NOTE: `order.shipping` is the legacy NUMERIC delivery fee and stays as-is.
 * readers use `estimateOf(order)` / `checkoutFreightOf(order)` which fall back
 * to the legacy fields (`plannedPackage`, `quotedCourier`, `estimatedShippingCost`).
 *
 *   order.logistics = {
 *     version: 1,
 *     customerFee,                         // ₹ charged at checkout (never changed later)
 *     estimate:       { … },               // written ONCE at order creation
 *     checkoutQuote:  { … },               // written ONCE at order creation
 *     verification:   { status, by, at },  // packing verification state
 *     actual:         { … } | null,        // latest verified measurement
 *     verifications:  [ … ],               // append-only history (never overwritten)
 *     dispatchQuote:  { … } | null,        // courier rate at booking
 *     difference:     { … } | null,        // actual − estimate
 *     adjustment:     { status, … },       // difference policy outcome / admin decision
 *     overrides:      [ … ],               // admin overrides (append-only)
 *   }
 */
'use strict';

const VERIFICATION_STATUS = Object.freeze(['pending', 'verified', 'overridden', 'not_required']);
const ADJUSTMENT_STATUS = Object.freeze([
  'none', // nothing measured yet / no difference
  'absorbed', // small difference — business absorbs, dispatch allowed
  'within_tolerance', // within auto-dispatch tolerance — allowed, reported
  'needs_approval', // large difference — admin must decide before booking
  'approved', // admin approved: business absorbs, dispatch allowed
  'customer_contacted', // admin is asking the customer — booking still blocked
  'refund_requested', // customer chose to cancel — use the refund workflow
]);
const DISPATCH_ALLOWED_ADJUSTMENTS = Object.freeze(['none', 'absorbed', 'within_tolerance', 'approved']);
const OVERRIDE_KINDS = Object.freeze(['skip_verification', 'panel_updated']);
const ADMIN_DECISIONS = Object.freeze({ approve: 'approved', customer_contacted: 'customer_contacted', refund_requested: 'refund_requested' });
const MAX_HISTORY = 20;

// null / '' stay null — a missing quote must never read as ₹0.
const isNum = (n) => n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n));
const r2 = (n) => (isNum(n) ? Math.round(Number(n) * 100) / 100 : null);
const r3 = (n) => (isNum(n) ? Math.round(Number(n) * 1000) / 1000 : null);
const str = (v, max = 80) => (v == null ? null : String(v).slice(0, max));
const nowIso = () => new Date().toISOString();

/** Estimate block from a packageService.buildPackage() result. */
function buildEstimate(pkg) {
  if (!pkg) return null;
  return {
    deadKg: r3(pkg.deadKg ?? pkg.weightKg),
    volumetricKg: r2(pkg.volumetricKg),
    chargeableKg: r3(pkg.chargeableKg),
    length: r2(pkg.length),
    breadth: r2(pkg.breadth),
    height: r2(pkg.height),
    packageId: str(pkg.boxId, 20),
    packageName: str(pkg.boxName, 40),
    packageType: str(pkg.packageType || 'box', 10),
    tareKg: r3(pkg.breakdown?.tareKg ?? null),
    materialCost: r2(pkg.materialCost ?? 0),
    confidence: str(pkg.confidence || null, 10),
    confidenceReasons: (pkg.confidenceReasons || []).slice(0, 10).map((x) => str(x, 120)),
    breakdown: pkg.breakdown || null,
    learnedKey: str(pkg.learned?.key || null, 200),
    signature: str(pkg.signature || null, 200),
    volumetricDivisor: pkg.volumetricDivisor || null,
    estimateVersion: pkg.estimateVersion || 1,
  };
}

/** Checkout quote block from deliveryService.computeDeliveryFee().quote. */
function buildCheckoutQuote(q) {
  if (!q) return null;
  return {
    method: q.method === 'fastest' ? 'fastest' : 'standard',
    partner: q.partner === 'local' ? 'local' : 'shiprocket',
    pincode: str(q.pincode, 6),
    courierId: q.courierId ?? null,
    courierName: str(q.courierName, 80),
    freight: r2(q.freight),
    estimatedDays: q.estimatedDays ?? null,
    fee: r2(q.fee),
    handlingFee: r2(q.handlingFee ?? 0),
    freightBufferPct: r2(q.freightBufferPct ?? 0),
    quotedWeightKg: r3(q.quotedWeightKg),
    slabKg: r2(q.slabKg),
    source: str(q.source || 'fallback', 10),
    quotedAt: q.quotedAt || nowIso(),
  };
}

/** Full initial shipping record for a new order. */
function buildInitialShipping({ pkg, quote, fee, requireVerification = true, partner = 'shiprocket' }) {
  return {
    version: 1,
    customerFee: r2(fee) ?? 0,
    estimate: buildEstimate(pkg),
    checkoutQuote: buildCheckoutQuote(quote),
    verification: { status: requireVerification && partner !== 'local' ? 'pending' : 'not_required' },
    actual: null,
    verifications: [],
    dispatchQuote: null,
    difference: null,
    adjustment: { status: 'none' },
    overrides: [],
  };
}

/** Estimate for any order — new record, else legacy `plannedPackage`. */
function estimateOf(order) {
  if (order?.logistics?.estimate) return order.logistics.estimate;
  const p = order?.plannedPackage;
  if (!p) return null;
  return {
    deadKg: r3(p.weightKg), volumetricKg: r2(p.volumetricKg), chargeableKg: r3(p.chargeableKg),
    length: r2(p.length), breadth: r2(p.breadth), height: r2(p.height),
    packageId: p.boxId || null, packageName: p.boxName || null, packageType: p.packageType || 'box',
    confidence: p.confidence || null, legacy: true,
  };
}

/** Freight quoted at checkout — new record, else legacy fields. */
function checkoutFreightOf(order) {
  const q = order?.logistics?.checkoutQuote;
  if (q?.freight != null) return Number(q.freight);
  if (order?.quotedCourier?.rate != null) return Number(order.quotedCourier.rate);
  if (order?.estimatedShippingCost != null) return Number(order.estimatedShippingCost);
  return null;
}

function checkoutCourierOf(order) {
  const q = order?.logistics?.checkoutQuote;
  if (q?.courierId != null) return { courierId: Number(q.courierId), name: q.courierName || null, rate: q.freight };
  if (order?.quotedCourier?.courierId != null) return order.quotedCourier;
  return null;
}

const customerFeeOf = (order) => Number(order?.logistics?.customerFee ?? order?.deliveryFee
  ?? (typeof order?.shipping === 'number' ? order.shipping : 0)) || 0;

/** Validated actual-measurement block. */
function buildActual(m, { packageId, packageName, packageType, materialCost, by, freight, courier }) {
  return {
    deadKg: r3(m.deadKg),
    volumetricKg: r2(m.volumetricKg),
    chargeableKg: r3(m.chargeableKg),
    length: r2(m.length),
    breadth: r2(m.breadth),
    height: r2(m.height),
    packageId: str(packageId, 20),
    packageName: str(packageName, 40),
    packageType: str(packageType || 'box', 10),
    materialCost: r2(materialCost ?? 0),
    freightQuote: r2(freight),
    freightCourierId: courier?.courierId ?? null,
    freightCourierName: str(courier?.name || null, 80),
    measuredBy: str(by, 120),
    measuredAt: nowIso(),
  };
}

/** actual − estimate, field by field (null where either side is unknown). */
function computeDifference(estimate, actual, { checkoutFreight, customerFee }) {
  const d = (a, b) => (a != null && b != null ? r3(Number(a) - Number(b)) : null);
  const freightRs = d(actual?.freightQuote, checkoutFreight);
  return {
    deadKg: d(actual?.deadKg, estimate?.deadKg),
    deadPct: estimate?.deadKg > 0 && actual?.deadKg != null ? r2(((actual.deadKg - estimate.deadKg) / estimate.deadKg) * 100) : null,
    volumetricKg: d(actual?.volumetricKg, estimate?.volumetricKg),
    chargeableKg: d(actual?.chargeableKg, estimate?.chargeableKg),
    freightRs: freightRs == null ? null : r2(freightRs),
    // What the parcel earns or loses on delivery: fee charged − (freight + packaging).
    marginRs: actual?.freightQuote != null
      ? r2((Number(customerFee) || 0) - Number(actual.freightQuote) - (Number(actual.materialCost) || 0))
      : null,
  };
}

/**
 * Policy for a freight difference (₹, actual − checkout). Never charges the
 * customer: large differences go to an admin.
 */
function adjustmentFor(freightRs, policy) {
  if (freightRs == null) return { status: 'none', reason: 'No freight quote to compare' };
  if (freightRs <= 0) return { status: 'none', reason: 'Actual freight within the checkout quote' };
  if (freightRs <= policy.absorbUpToRs) return { status: 'absorbed', reason: `₹${freightRs} over quote — absorbed (≤ ₹${policy.absorbUpToRs})` };
  if (freightRs <= policy.autoDispatchUpToRs) return { status: 'within_tolerance', reason: `₹${freightRs} over quote — within tolerance (≤ ₹${policy.autoDispatchUpToRs})` };
  return { status: 'needs_approval', reason: `₹${freightRs} over quote — above ₹${policy.autoDispatchUpToRs}, admin approval needed` };
}

const pushHistory = (list, entry) => [...(Array.isArray(list) ? list : []), entry].slice(-MAX_HISTORY);

module.exports = {
  VERIFICATION_STATUS,
  ADJUSTMENT_STATUS,
  DISPATCH_ALLOWED_ADJUSTMENTS,
  OVERRIDE_KINDS,
  ADMIN_DECISIONS,
  buildEstimate,
  buildCheckoutQuote,
  buildInitialShipping,
  buildActual,
  estimateOf,
  checkoutFreightOf,
  checkoutCourierOf,
  customerFeeOf,
  computeDifference,
  adjustmentFor,
  pushHistory,
};
