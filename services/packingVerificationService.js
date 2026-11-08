/**
 * packingVerificationService.js — staff weigh + measure the packed parcel
 * before courier booking; the system compares it with the checkout estimate,
 * applies the freight-difference policy, records history and feeds the
 * historical-learning store. Also: admin overrides / decisions and shipping
 * analytics.
 *
 * Never touches the customer's payment: a large difference only blocks
 * booking until an admin decides (absorb / contact customer / refund via the
 * existing refund workflow).
 */
'use strict';

const db = require('../config/firebase');
const log = require('../lib/logger');
const shiprocket = require('./shiprocketService');
const packaging = require('./packageService');
const packingStats = require('./packingStatsService');
const shipping = require('./shippingService');
const model = require('../models/orderShipping');

const { ShippingError, SHIPPABLE_STATES, chooseDispatchCourier, dispatchBlock } = shipping;

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const MIN_REASON = 5;

/** Has the order already been pushed with measurements that differ from these? */
function pushedMismatchOf(sh, actual) {
  const p = sh?.package;
  if (!sh?.shipmentId || sh.awb || !p) return false;
  const near = (a, b, tol) => Math.abs(Number(a) - Number(b)) <= tol;
  const sidesA = [p.length, p.breadth, p.height].map(Number).sort((a, b) => b - a);
  const sidesB = [actual.length, actual.breadth, actual.height].map(Number).sort((a, b) => b - a);
  return !(near(p.weightKg, actual.deadKg, 0.01) && sidesA.every((s, i) => near(s, sidesB[i], 0.5)));
}

/** Freight for the measured parcel: the courier that would be booked. null if unknown. */
async function quoteActualFreight(order, chargeableKg) {
  if (!shiprocket.isEnabled() || order.deliveryPartner === 'local') return { freight: null, courier: null, note: 'not_quoted' };
  const pin = order.customerInfo?.pincode || order.deliveryPincode;
  if (!pin) return { freight: null, courier: null, note: 'no_pincode' };
  try {
    const r = await shiprocket.checkServiceability({ deliveryPincode: pin, weightKg: chargeableKg });
    if (!r.serviceable) return { freight: null, courier: null, note: 'not_serviceable' };
    const { courier, pick } = chooseDispatchCourier(r.couriers, {
      method: order.deliveryMethod === 'fastest' ? 'fastest' : 'standard',
      checkout: model.checkoutCourierOf(order),
    });
    return courier ? { freight: courier.rate, courier: { courierId: courier.courierId, name: courier.name }, note: pick } : { freight: null, courier: null, note: 'no_courier' };
  } catch (err) {
    log.warn('packing.freight_quote_failed', { err });
    return { freight: null, courier: null, note: 'quote_failed' };
  }
}

/**
 * Record the measured parcel for an order.
 * @param {{ weightKg, length, breadth, height, packageId?, packageType?, materialCost? }} input
 * @returns {Promise<{ logistics: object, dispatch: { allowed: boolean, block: object|null } }>}
 */
async function verifyPacking(orderId, input = {}, { by } = {}) {
  const settings = await packaging.getPackagingSettings();
  const m = packaging.measure(input, settings);
  if (!m) throw new ShippingError('BAD_MEASUREMENT', 'Enter the parcel weight (kg) and all three external sides (cm).');

  let box = null;
  const pid = String(input.packageId || '').trim().toUpperCase();
  if (pid && pid !== 'CUSTOM') {
    box = settings.boxes.find((b) => b.id === pid) || null;
    if (!box) throw new ShippingError('BAD_PACKAGE', `Unknown package "${input.packageId}"`);
  }
  const packageType = box?.type || (packaging.PACKAGE_TYPES.includes(input.packageType) ? input.packageType : 'box');
  let materialCost = box?.materialCost ?? 0;
  if (input.materialCost !== '' && input.materialCost != null) {
    const mc = Number(input.materialCost);
    if (!Number.isFinite(mc) || mc < 0 || mc > packaging.LIMITS.MATERIAL_COST_MAX) {
      throw new ShippingError('BAD_MEASUREMENT', `Packaging material cost must be between ₹0 and ₹${packaging.LIMITS.MATERIAL_COST_MAX}`);
    }
    materialCost = r2(mc);
  }

  const ref = db.collection('orders').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  const order = snap.data();
  const sh = order.shipment || {};
  if (sh.awb) throw new ShippingError('ALREADY_BOOKED', 'A courier is already booked — measurements are locked for this shipment.', 409);
  if (!SHIPPABLE_STATES.includes(order.status)) {
    throw new ShippingError('NOT_SHIPPABLE', `Order in "${order.status}" state cannot be packed`);
  }

  // Estimate: written once at checkout; reconstructed (and flagged) for older orders.
  let estimate = model.estimateOf(order);
  let reconstructed = false;
  if (!estimate) {
    try {
      estimate = model.buildEstimate(await packaging.resolveOrderPackage(order));
      reconstructed = true;
    } catch (err) {
      log.warn('packing.estimate_rebuild_failed', { orderId, err });
    }
  }

  const fq = await quoteActualFreight(order, m.chargeableKg);
  const actual = model.buildActual(m, {
    packageId: box?.id || null,
    packageName: box?.name || 'Custom',
    packageType,
    materialCost,
    by,
    freight: fq.freight,
    courier: fq.courier,
  });
  const checkoutFreight = model.checkoutFreightOf(order);
  const difference = model.computeDifference(estimate, actual, { checkoutFreight, customerFee: model.customerFeeOf(order) });
  const verdict = model.adjustmentFor(difference.freightRs, settings.adjustment);
  const pushedMismatch = pushedMismatchOf(sh, actual);

  const lg = order.logistics || {};
  const entry = { ...actual, difference, adjustment: verdict.status, freightNote: fq.note };
  const update = {
    'logistics.version': 1,
    'logistics.actual': actual,
    'logistics.difference': difference,
    'logistics.verification': { status: 'verified', by: by || null, at: actual.measuredAt },
    'logistics.verifications': model.pushHistory(lg.verifications, entry),
    'logistics.adjustment': {
      status: verdict.status,
      reason: verdict.reason,
      freightRs: difference.freightRs,
      stage: 'packing',
      at: actual.measuredAt,
      ...(lg.adjustment?.status && lg.adjustment.status !== 'none' ? { previous: lg.adjustment.status } : {}),
    },
    'logistics.pushedMismatch': pushedMismatch,
    'logistics.freightNote': fq.note,
  };
  if (!lg.estimate && estimate) {
    update['logistics.estimate'] = { ...estimate, reconstructed };
  }
  if (lg.customerFee == null) update['logistics.customerFee'] = model.customerFeeOf(order);

  await db.runTransaction(async (t) => {
    const cur = await t.get(ref);
    if (cur.data().shipment?.awb) throw new ShippingError('ALREADY_BOOKED', 'A courier was just booked — measurements are locked.', 409);
    t.update(ref, update);
  });

  // Learn from it: actual vs the BASE estimate for the package actually used.
  if (settings.learning.enabled) {
    try {
      const items = order.items || [];
      const base = packaging.buildPackage(items, settings, box ? { boxId: box.id } : { length: m.length, breadth: m.breadth, height: m.height }, { learned: null });
      const b = base.breakdown;
      const baseKg = b.contentsKg + b.innerKg + b.tareKg + b.fillerKg + b.packingKg;
      await packingStats.recordSample({
        signature: base.signature, boxId: box?.id || null, baseEstimateKg: baseKg, actualKg: m.deadKg, orderId,
      }, settings.learning);
    } catch (err) {
      log.warn('packing.learning_failed', { orderId, err });
    }
  }

  const fresh = (await ref.get()).data();
  const block = dispatchBlock(fresh, settings, { stage: fresh.shipment?.shipmentId ? 'awb' : 'create' });
  log.info('packing.verified', { orderId, adjustment: verdict.status, freightRs: difference.freightRs, pushedMismatch });
  return { logistics: fresh.logistics, dispatch: { allowed: !block, block } };
}

/**
 * Admin override of the verification gate.
 *   skip_verification — book without measuring (recorded with reason)
 *   panel_updated     — the pushed Shiprocket order was corrected in the panel
 */
async function overridePacking(orderId, { kind, reason } = {}, { by } = {}) {
  if (!model.OVERRIDE_KINDS.includes(kind)) throw new ShippingError('BAD_OVERRIDE', `Override must be one of: ${model.OVERRIDE_KINDS.join(', ')}`);
  const why = String(reason || '').trim().slice(0, 300);
  if (why.length < MIN_REASON) throw new ShippingError('BAD_OVERRIDE', 'Give a short reason for the override (at least 5 characters).');
  const ref = db.collection('orders').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  const order = snap.data();
  if (order.shipment?.awb) throw new ShippingError('ALREADY_BOOKED', 'A courier is already booked.', 409);
  const lg = order.logistics || {};
  const at = new Date().toISOString();
  const update = { 'logistics.overrides': model.pushHistory(lg.overrides, { kind, reason: why, by: by || null, at }) };
  if (kind === 'skip_verification') {
    if (lg.verification?.status === 'verified') throw new ShippingError('BAD_OVERRIDE', 'This parcel is already verified.');
    update['logistics.verification'] = { status: 'overridden', by: by || null, at, reason: why };
  } else if (!lg.pushedMismatch) {
    throw new ShippingError('BAD_OVERRIDE', 'There is no Shiprocket measurement mismatch to confirm.');
  }
  await ref.update(update);
  return (await ref.get()).data().logistics;
}

/**
 * Admin decision on a freight difference.
 *   approve            — business absorbs it; booking allowed
 *   customer_contacted — waiting on the customer; booking stays blocked
 *   refund_requested   — customer chose to cancel; handled by the refund workflow
 * The customer is never charged from here.
 */
async function decideAdjustment(orderId, { decision, note } = {}, { by } = {}) {
  const status = model.ADMIN_DECISIONS[decision];
  if (!status) throw new ShippingError('BAD_DECISION', `Decision must be one of: ${Object.keys(model.ADMIN_DECISIONS).join(', ')}`);
  const ref = db.collection('orders').doc(orderId);
  const snap = await ref.get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  const lg = snap.data().logistics || {};
  const cur = lg.adjustment?.status || 'none';
  if (!['needs_approval', 'customer_contacted'].includes(cur)) {
    throw new ShippingError('BAD_DECISION', `Nothing to decide — the difference is "${cur.replace(/_/g, ' ')}".`);
  }
  const at = new Date().toISOString();
  await ref.update({
    'logistics.adjustment': {
      ...lg.adjustment,
      status,
      decidedBy: by || null,
      decidedAt: at,
      note: String(note || '').trim().slice(0, 300) || null,
      previous: cur,
    },
    'logistics.overrides': model.pushHistory(lg.overrides, { kind: `adjustment_${decision}`, reason: String(note || '').slice(0, 300), by: by || null, at }),
  });
  return (await ref.get()).data().logistics;
}

/* ── analytics ─────────────────────────────────────────────────────────── */

const ANALYTICS_MAX = 2000;
const avg = (xs) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * Shipping profit/loss and estimate accuracy over the last `days`.
 * Uses the courier actually booked (logistics.actualFreight / shipment.freightEstimate),
 * else the verified-parcel quote.
 */
async function shippingAnalytics({ days = 30 } = {}) {
  const d = Math.min(365, Math.max(1, Number(days) || 30));
  const since = new Date(Date.now() - d * 86400000);
  const snap = await db.collection('orders').where('createdAt', '>=', since).limit(ANALYTICS_MAX).get();

  const totals = {
    orders: 0, shipped: 0, verified: 0,
    estimatedFreight: 0, actualFreight: 0, revenue: 0, materialCost: 0,
    losses: 0, profit: 0,
  };
  const weightDiffs = [];
  const volDiffs = [];
  const byCourier = new Map();
  const byPackage = new Map();
  const review = [];
  const bump = (map, key, row) => {
    const cur = map.get(key) || { key, orders: 0, freight: 0, revenue: 0, profit: 0, weightDiffs: [] };
    cur.orders += 1; cur.freight += row.freight; cur.revenue += row.revenue; cur.profit += row.profit;
    if (row.weightDiff != null) cur.weightDiffs.push(row.weightDiff);
    map.set(key, cur);
  };

  snap.forEach((doc) => {
    const o = doc.data();
    if (['payment_pending', 'cancelled', 'payment_failed', 'failed'].includes(o.status)) return;
    totals.orders += 1;
    const lg = o.logistics || {};
    const est = model.checkoutFreightOf(o);
    const fee = model.customerFeeOf(o);
    const booked = lg.actualFreight ?? o.shipment?.freightEstimate ?? null;
    const actual = booked ?? lg.actual?.freightQuote ?? null;
    const material = Number(lg.actual?.materialCost) || 0;
    if (lg.verification?.status === 'verified') totals.verified += 1;
    if (lg.difference?.deadKg != null) weightDiffs.push(lg.difference.deadKg);
    if (lg.difference?.volumetricKg != null) volDiffs.push(lg.difference.volumetricKg);

    const status = lg.adjustment?.status;
    if (status === 'needs_approval' || status === 'customer_contacted' || lg.pushedMismatch || o.shipment?.needsAttention) {
      review.push({
        orderId: doc.id,
        status: o.status,
        reason: lg.pushedMismatch ? 'Shiprocket measurements differ' : o.shipment?.needsAttention ? 'Shiprocket push failed' : (lg.adjustment?.reason || status),
        freightRs: lg.adjustment?.freightRs ?? null,
      });
    }
    if (actual == null) return;
    totals.shipped += booked != null ? 1 : 0;
    totals.estimatedFreight += est ?? 0;
    totals.actualFreight += actual;
    totals.revenue += fee;
    totals.materialCost += material;
    const profit = fee - actual - material;
    totals.profit += profit;
    if (profit < 0) totals.losses += -profit;
    const row = { freight: actual, revenue: fee, profit, weightDiff: lg.difference?.deadKg ?? null };
    bump(byCourier, lg.dispatchQuote?.courierName || o.shipment?.courierName || lg.actual?.freightCourierName || 'Not booked', row);
    bump(byPackage, lg.actual?.packageId || o.shipment?.package?.boxId || lg.estimate?.packageId || 'Custom', row);
  });

  const finish = (map) => [...map.values()].map((r) => ({
    key: r.key, orders: r.orders, freight: r2(r.freight), revenue: r2(r.revenue), profit: r2(r.profit),
    avgWeightDiffKg: avg(r.weightDiffs),
  })).sort((a, b) => b.orders - a.orders);

  return {
    days: d,
    since: since.toISOString(),
    truncated: snap.size >= ANALYTICS_MAX,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])),
    avgWeightDiffKg: avg(weightDiffs),
    avgVolumetricDiffKg: avg(volDiffs),
    couriers: finish(byCourier),
    packages: finish(byPackage),
    review: review.slice(0, 100),
  };
}

module.exports = {
  verifyPacking,
  overridePacking,
  decideAdjustment,
  shippingAnalytics,
  pushedMismatchOf,
};
