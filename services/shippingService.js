/**
 * shippingService.js — order-level Shiprocket orchestration.
 *
 * Lifecycle of `order.shipment` (provider: 'shiprocket'):
 *   1. createShipmentForOrder()  — push the paid order to Shiprocket (state 'created')
 *   2. shipOrder()               — assign AWB/courier, schedule pickup, fetch label
 *                                  (state 'awb_assigned' → 'pickup_scheduled'; order → packed)
 *   3. applyTrackingUpdate()     — webhook / manual sync moves the order through
 *                                  shipped → out_for_delivery → delivered
 *
 * Courier updates only ever move an order FORWARD along the fulfilment chain
 * (plus the courier's own out_for_delivery → shipped re-attempt). Terminal
 * states (delivered / refunded / cancelled) are never touched.
 *
 * Exceptions don't change order.status; they set shipment.state / flags and
 * alert staff once:
 *   NDR (failed delivery attempt) → shipment.ndr       (staff call the customer)
 *   RTO initiated / in transit    → 'rto_in_transit'  (parcel coming back)
 *   RTO delivered                 → 'rto_delivered'   (inspect, then refund → restocks)
 *   lost / damaged / destroyed    → 'lost'            (claim with Shiprocket, refund)
 *   cancelled in Shiprocket       → 'cancelled'
 *
 * Orders whose PIN is served by the dedicated LOCAL partner
 * (order.deliveryPartner === 'local') are never pushed automatically.
 */
'use strict';

const admin = require('../lib/firebaseAdmin');
const db = require('../config/firebase');
const log = require('../lib/logger');
const shiprocket = require('./shiprocketService');
const packaging = require('./packageService');
const { ORDER_TRANSITIONS } = require('../config/constants');

const PROVIDER = 'shiprocket';

/** Order states from which a shipment may be created. */
const SHIPPABLE_STATES = Object.freeze(['pending', 'processing', 'packed', 'payment_successful_no_stock']);

const FLOW = ['pending', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered'];
const flowRank = (s) => (s === 'payment_successful_no_stock' ? 0 : FLOW.indexOf(s));

/**
 * Map a Shiprocket shipment status label to an Alimenture order status.
 * Returns { status: string|null, exception: boolean, kind: string|null }.
 * kind ∈ 'rto' | 'rto_delivered' | 'ndr' | 'lost' | 'cancelled' | 'exception'
 */
function mapCourierStatus(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/_/g, ' ');
  const ex = (kind) => ({ status: null, exception: true, kind });
  if (!s) return { status: null, exception: false, kind: null };
  if (s.includes('RTO') || /RETURN(ED)? TO ORIGIN/.test(s)) {
    return ex(/DELIVERED/.test(s) && !/UNDELIVERED/.test(s) ? 'rto_delivered' : 'rto');
  }
  if (/LOST|DAMAGED|DESTROYED|DISPOSED/.test(s)) return ex('lost');
  if (/CANCEL/.test(s)) return ex('cancelled');
  if (/UNDELIVERED|NDR|DELIVERY FAILED|FAILED DELIVERY|NOT DELIVERED/.test(s)) return ex('ndr');
  if (/MISROUTED/.test(s)) return ex('exception');
  if (s === 'DELIVERED') return { status: 'delivered', exception: false, kind: null };
  if (s.includes('OUT FOR DELIVERY')) return { status: 'out_for_delivery', exception: false, kind: null };
  if (/PICKED UP|SHIPPED|IN TRANSIT|REACHED|DESTINATION HUB|AT HUB|DELAYED/.test(s)) {
    return { status: 'shipped', exception: false, kind: null };
  }
  if (/PICKUP|MANIFEST|AWB|LABEL|READY TO SHIP/.test(s)) return { status: 'packed', exception: false, kind: null };
  return { status: null, exception: false, kind: null };
}

/** Shipment states after which forward courier scans no longer move the order. */
const HALTED_STATES = Object.freeze(['rto_in_transit', 'rto_delivered', 'lost', 'cancelled']);
const STATE_FOR_KIND = Object.freeze({ rto: 'rto_in_transit', rto_delivered: 'rto_delivered', lost: 'lost', cancelled: 'cancelled' });

/** May a courier-driven update move `current` → `target`? */
function canAdvance(current, target) {
  if (!target || current === target) return false;
  const from = flowRank(current);
  const to = flowRank(target);
  if (from === -1 || to === -1) return false; // payment_pending / cancelled / refunded …
  if (to > from) return true;
  return (ORDER_TRANSITIONS[current] || []).includes(target);
}

const now = () => admin.firestore.FieldValue.serverTimestamp();

class ShippingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ShippingError';
    this.code = code;
    this.status = status;
  }
}

function assertEnabled() {
  if (!shiprocket.isEnabled()) {
    throw new ShippingError('SHIPROCKET_DISABLED', 'Shiprocket is not configured on the server', 503);
  }
}

/* ── 1. create ─────────────────────────────────────────────────────────── */

const CLAIM_TTL_MS = 2 * 60 * 1000;

/**
 * Push an order to Shiprocket. Idempotent: an order that already has a
 * Shiprocket shipment is returned as-is.
 * @param {{ source?: string, packageOverride?: object }} opts
 *   packageOverride — `{ boxId }` or `{ length, breadth, height }`, optional `weightKg`
 *   (validated by packageService.parseOverride). Omit for automatic box selection.
 */
async function createShipmentForOrder(orderId, { source = 'admin', packageOverride = null, force = false } = {}) {
  assertEnabled();
  const orderRef = db.collection('orders').doc(orderId);

  // Claim the order so a double click / concurrent auto-create can't push it twice.
  const claimed = await db.runTransaction(async (t) => {
    const snap = await t.get(orderRef);
    if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
    const order = snap.data();
    const sh = order.shipment || {};
    if (sh.shipmentId) return { existing: sh };
    if (!SHIPPABLE_STATES.includes(order.status)) {
      throw new ShippingError('NOT_SHIPPABLE', `Order in "${order.status}" state cannot be shipped`);
    }
    if (order.deliveryPartner === 'local' && !force) {
      throw new ShippingError('LOCAL_PARTNER', 'This PIN code is delivered by your local delivery partner. Use "Ship via Shiprocket anyway" to override.', 409);
    }
    const claimAt = sh.claimedAt?.toMillis ? sh.claimedAt.toMillis() : 0;
    if (sh.state === 'creating' && Date.now() - claimAt < CLAIM_TTL_MS) {
      throw new ShippingError('BUSY', 'Shipment creation already in progress', 409);
    }
    t.update(orderRef, {
      shipment: {
        provider: PROVIDER,
        state: 'creating',
        claimedAt: admin.firestore.Timestamp.now(),
        retryCount: Number(sh.retryCount) || 0,
      },
      updatedAt: now(),
    });
    return { order };
  });
  if (claimed.existing) return claimed.existing;

  const ci = claimed.order.customerInfo || {};
  if (!ci.pincode || !ci.state || !ci.phone) {
    await orderRef.update({
      shipment: {
        provider: PROVIDER, state: 'failed', error: 'Address is missing PIN code, state or phone',
        retryCount: Number(claimed.order.shipment?.retryCount) || 0, updatedAt: admin.firestore.Timestamp.now(),
      },
    });
    throw new ShippingError('INCOMPLETE_ADDRESS', 'Order address is missing PIN code, state or phone number');
  }

  try {
    let pkg;
    try {
      pkg = await packaging.resolveOrderPackage(claimed.order, packageOverride);
    } catch (err) {
      if (err.code === 'BAD_BOX') throw new ShippingError('BAD_PACKAGE', err.message);
      throw err;
    }
    const created = await shiprocket.createOrder(orderId, claimed.order, pkg);
    const shipment = {
      provider: PROVIDER,
      state: 'created',
      srOrderId: created.srOrderId,
      shipmentId: created.shipmentId,
      courierStatus: created.srStatus,
      weightKg: created.weightKg,
      package: {
        boxId: pkg.boxId,
        boxName: pkg.boxName,
        length: pkg.length,
        breadth: pkg.breadth,
        height: pkg.height,
        weightKg: pkg.weightKg,
        volumetricKg: pkg.volumetricKg,
        chargeableKg: pkg.chargeableKg,
        source: pkg.source,
      },
      createdAt: admin.firestore.Timestamp.now(),
      createdBy: source,
    };
    await orderRef.update({ shipment, updatedAt: now() });
    log.info('shipping.order_created', { orderId, shipmentId: created.shipmentId, source });
    return shipment;
  } catch (err) {
    await orderRef.update({
      shipment: {
        provider: PROVIDER, state: 'failed', error: String(err.message).slice(0, 300),
        retryCount: Number(claimed.order.shipment?.retryCount) || 0, updatedAt: admin.firestore.Timestamp.now(),
      },
    }).catch(() => {});
    throw err;
  }
}

const autoCreateOn = () => shiprocket.isEnabled() && process.env.SHIPROCKET_AUTO_CREATE !== 'false';

/** Fire-and-forget hook used after payment confirmation. Never throws. */
async function autoCreateShipment(orderId) {
  if (!autoCreateOn()) return;
  try {
    await createShipmentForOrder(orderId, { source: 'auto' });
  } catch (err) {
    if (err instanceof ShippingError && err.code === 'LOCAL_PARTNER') return; // delivered by the local partner
    log.warn('shipping.auto_create_failed', { orderId, err });
  }
}

/* ── 1b. retry job ─────────────────────────────────────────────────────── */

const RETRY_MAX = 3;
const RETRY_MIN_AGE_MS = 10 * 60 * 1000;
const RETRY_SCAN_LIMIT = 200;
const tsMs = (t) => (t?.toMillis ? t.toMillis() : (t ? new Date(t).getTime() || 0 : 0));

/**
 * Re-push paid orders whose automatic Shiprocket push failed or never ran.
 * Gives up after RETRY_MAX attempts and flags the order (shipment.needsAttention).
 * @param {{ onGiveUp?: (orderId: string, error: string) => void }} [hooks]
 * @returns {Promise<{ scanned: number, retried: number, succeeded: number, gaveUp: number }>}
 */
async function retryFailedShipments({ onGiveUp } = {}) {
  const out = { scanned: 0, retried: 0, succeeded: 0, gaveUp: 0 };
  if (!autoCreateOn()) return out;
  // A paused Shiprocket login would fail every order and burn its retries — wait it out.
  if (shiprocket.authStatus().paused) return { ...out, skipped: 'login_paused' };
  const snap = await db.collection('orders')
    .where('status', 'in', ['pending', 'processing'])
    .limit(RETRY_SCAN_LIMIT)
    .get();
  const cutoff = Date.now() - RETRY_MIN_AGE_MS;

  for (const doc of snap.docs) {
    out.scanned += 1;
    const o = doc.data();
    const sh = o.shipment || {};
    if (o.deliveryPartner === 'local' || sh.shipmentId || sh.needsAttention) continue;
    const stale = !sh.state || sh.state === 'failed'
      || (sh.state === 'creating' && tsMs(sh.claimedAt) < Date.now() - CLAIM_TTL_MS);
    if (!stale) continue;
    if (tsMs(o.paidAt || o.createdAt) > cutoff) continue; // the first auto-push may still be running
    const attempts = Number(sh.retryCount) || 0;
    if (attempts >= RETRY_MAX) continue;

    out.retried += 1;
    try {
      await createShipmentForOrder(doc.id, { source: 'retry' });
      out.succeeded += 1;
      log.info('shipping.retry_ok', { orderId: doc.id, attempt: attempts + 1 });
    } catch (err) {
      const giveUp = attempts + 1 >= RETRY_MAX;
      await doc.ref.update({
        'shipment.retryCount': attempts + 1,
        ...(giveUp ? { 'shipment.needsAttention': true } : {}),
      }).catch(() => {});
      log.warn('shipping.retry_failed', { orderId: doc.id, attempt: attempts + 1, err });
      if (giveUp) {
        out.gaveUp += 1;
        onGiveUp?.(doc.id, String(err.message || err).slice(0, 200));
      }
    }
  }
  return out;
}

/** Preview the parcel (box, size, weight) an order would be shipped in. */
async function previewPackage(orderId, override = null) {
  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  try {
    return await packaging.resolveOrderPackage(snap.data(), override);
  } catch (err) {
    if (err.code === 'BAD_BOX') throw new ShippingError('BAD_PACKAGE', err.message);
    throw err;
  }
}

/* ── 2. courier + pickup ───────────────────────────────────────────────── */

async function listCouriers(orderId) {
  assertEnabled();
  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  const sh = snap.data().shipment || {};
  if (!sh.srOrderId) throw new ShippingError('NO_SHIPMENT', 'Create the Shiprocket shipment first');
  const r = await shiprocket.checkServiceability({ srOrderId: sh.srOrderId });
  const express = pickExpressCourier(r.couriers);
  return {
    ...r,
    expressId: express?.courierId || null,
    deliveryMethod: snap.data().deliveryMethod || 'standard',
  };
}

/** Fastest air/express courier: non-surface, fewest days, then cheapest. */
function pickExpressCourier(couriers = []) {
  return couriers
    .filter((c) => !c.isSurface && c.estimatedDays)
    .sort((a, b) => a.estimatedDays - b.estimatedDays || a.rate - b.rate)[0] || null;
}

/**
 * Assign AWB (chosen or recommended courier), request pickup and fetch the
 * label. Each step is persisted as it completes, so a retry resumes where the
 * previous attempt stopped. Moves the order to `packed`.
 * @returns {{ shipment, statusChange: { from, to }|null }}
 */
async function shipOrder(orderId, { courierId, force = false } = {}) {
  assertEnabled();
  const orderRef = db.collection('orders').doc(orderId);
  let snap = await orderRef.get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  let sh = snap.data().shipment || {};

  if (!sh.shipmentId) {
    sh = await createShipmentForOrder(orderId, { force });
  }

  const patch = {};
  if (!sh.awb) {
    // Courier quotes for this shipment: freight estimate (margin) + express pick for "fastest".
    let quotes = null;
    try {
      quotes = await shiprocket.checkServiceability({ srOrderId: sh.srOrderId });
    } catch (err) {
      log.warn('shipping.quote_failed', { orderId, err });
    }
    let chosenId = courierId ? Number(courierId) : undefined;
    let courierPick = chosenId ? 'staff' : 'recommended';
    if (!chosenId && snap.data().deliveryMethod === 'fastest' && quotes) {
      const express = pickExpressCourier(quotes.couriers);
      if (express) {
        chosenId = express.courierId;
        courierPick = 'express';
      } else {
        courierPick = 'recommended_no_express';
      }
    }

    const awb = await shiprocket.assignAwb(sh.shipmentId, chosenId);
    const assignedId = awb.courierId || chosenId || quotes?.recommendedId;
    const quote = quotes?.couriers.find((c) => c.courierId === assignedId);
    Object.assign(patch, {
      'shipment.awb': awb.awb,
      'shipment.courierId': awb.courierId || null,
      'shipment.courierName': awb.courierName || null,
      'shipment.courierPick': courierPick,
      'shipment.freightEstimate': quote ? quote.rate : null,
      'shipment.state': 'awb_assigned',
      'shipment.awbAssignedAt': admin.firestore.Timestamp.now(),
      'shipment.error': courierPick === 'recommended_no_express'
        ? 'Fastest order, but no express courier serves this PIN — Shiprocket recommended courier used'
        : admin.firestore.FieldValue.delete(),
    });
    await orderRef.update(patch);
    sh = { ...sh, awb: awb.awb, courierName: awb.courierName };
  }

  if (!sh.pickupRequestedAt) {
    try {
      const pickup = await shiprocket.generatePickup(sh.shipmentId);
      await orderRef.update({
        'shipment.state': 'pickup_scheduled',
        'shipment.pickupRequestedAt': admin.firestore.Timestamp.now(),
        'shipment.pickupScheduledDate': pickup.scheduledDate,
      });
    } catch (err) {
      // Pickup can be requested again from the Shiprocket panel — don't fail the AWB.
      log.warn('shipping.pickup_failed', { orderId, err });
      await orderRef.update({ 'shipment.error': `Pickup request failed: ${String(err.message).slice(0, 200)}` });
    }
  }

  if (!sh.labelUrl) {
    try {
      const labelUrl = await shiprocket.generateLabel(sh.shipmentId);
      await orderRef.update({ 'shipment.labelUrl': labelUrl });
    } catch (err) {
      log.warn('shipping.label_failed', { orderId, err });
    }
  }

  const statusChange = await applyTrackingUpdate(orderId, { forceStatus: 'packed' });
  snap = await orderRef.get();
  return { shipment: snap.data().shipment, statusChange };
}

/* ── 3. tracking ───────────────────────────────────────────────────────── */

/**
 * Persist courier tracking onto the order and advance its status when allowed.
 * `courierStatus` is the raw Shiprocket label; `forceStatus` lets shipOrder()
 * set `packed` directly.
 * @returns {Promise<{ from: string, to: string|null, order: object,
 *   alert: null|'ndr'|'rto'|'rto_delivered'|'lost'|'cancelled'|'exception' }|null>}
 *   null when nothing worth notifying happened.
 */
async function applyTrackingUpdate(orderId, {
  courierStatus, etd, trackUrl, activities, awb, courierName, forceStatus,
} = {}) {
  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async (t) => {
    const snap = await t.get(orderRef);
    if (!snap.exists) return null;
    const order = snap.data();
    const prev = order.shipment || {};

    const mapped = forceStatus ? { status: forceStatus, exception: false, kind: null } : mapCourierStatus(courierStatus);
    const label = String(courierStatus || '').toUpperCase();
    const update = { updatedAt: now(), 'shipment.lastSyncedAt': admin.firestore.Timestamp.now() };
    if (courierStatus) update['shipment.courierStatus'] = label;
    if (etd) update['shipment.etd'] = String(etd);
    if (trackUrl) update['shipment.trackUrl'] = trackUrl;
    if (awb && !prev.awb) update['shipment.awb'] = String(awb);
    if (courierName && !prev.courierName) update['shipment.courierName'] = courierName;
    if (Array.isArray(activities) && activities.length) update['shipment.activities'] = activities.slice(0, 25);

    let alert = null;
    const halted = HALTED_STATES.includes(prev.state);

    if (mapped.exception) {
      update['shipment.exception'] = label;
      const nextState = STATE_FOR_KIND[mapped.kind];
      if (nextState && prev.state !== nextState) {
        update['shipment.state'] = nextState;
        update[`shipment.${nextState}At`] = admin.firestore.Timestamp.now();
        alert = mapped.kind;
      } else if (mapped.kind === 'ndr' && !halted) {
        const ndrCount = (Number(prev.ndr?.count) || 0) + (prev.ndr?.status === label ? 0 : 1);
        update['shipment.ndr'] = { status: label, count: ndrCount, at: admin.firestore.Timestamp.now() };
        if (prev.ndr?.status !== label) alert = 'ndr';
      } else if (mapped.kind === 'exception' && prev.exception !== label) {
        alert = 'exception';
      }
    } else if (mapped.status && !halted) {
      update['shipment.exception'] = admin.firestore.FieldValue.delete();
      if (mapped.status === 'delivered') update['shipment.ndr'] = admin.firestore.FieldValue.delete();
    }

    if (!halted && !mapped.exception) {
      if (mapped.status === 'delivered') update['shipment.state'] = 'delivered';
      else if (mapped.status === 'shipped' || mapped.status === 'out_for_delivery') update['shipment.state'] = 'in_transit';
    }

    let to = null;
    if (!halted && canAdvance(order.status, mapped.status)) {
      update.status = mapped.status;
      if (mapped.status === 'delivered') update.deliveredAt = now();
      to = mapped.status;
    }
    t.update(orderRef, update);
    return to || alert ? { from: order.status, to, order, alert } : null;
  });
}

/** Pull the latest tracking from Shiprocket for an order with an AWB. */
async function refreshTracking(orderId) {
  assertEnabled();
  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  const awb = snap.data().shipment?.awb;
  if (!awb) throw new ShippingError('NO_AWB', 'No AWB assigned yet');
  const tr = await shiprocket.trackAwb(awb);
  return applyTrackingUpdate(orderId, {
    courierStatus: tr.status, etd: tr.etd, trackUrl: tr.trackUrl, activities: tr.activities,
  });
}

/** Shipment states in which Shiprocket still allows cancellation (not yet picked up). */
const CANCELLABLE_STATES = Object.freeze(['created', 'awb_assigned', 'pickup_scheduled', 'failed']);

/**
 * Cancel an order's Shiprocket shipment if the courier hasn't picked it up yet
 * (used on refund). Never throws.
 * @returns {Promise<'cancelled'|'not_needed'|'too_late'|'failed'>}
 */
async function cancelShipmentForOrder(orderId, { reason = 'refund' } = {}) {
  const orderRef = db.collection('orders').doc(orderId);
  try {
    const snap = await orderRef.get();
    const sh = snap.exists ? snap.data().shipment || {} : {};
    if (!sh.srOrderId || ['cancelled', 'rto_in_transit', 'rto_delivered', 'lost'].includes(sh.state)) return 'not_needed';
    if (!CANCELLABLE_STATES.includes(sh.state)) {
      await orderRef.update({ 'shipment.error': `Not cancelled in Shiprocket on ${reason}: parcel already with the courier` });
      return 'too_late';
    }
    if (!shiprocket.isEnabled()) throw new Error('Shiprocket is not configured');
    await shiprocket.cancelOrder(sh.srOrderId);
    await orderRef.update({
      'shipment.state': 'cancelled',
      'shipment.cancelledAt': admin.firestore.Timestamp.now(),
      'shipment.cancelReason': reason,
      'shipment.error': admin.firestore.FieldValue.delete(),
    });
    log.info('shipping.cancelled', { orderId, srOrderId: sh.srOrderId, reason });
    return 'cancelled';
  } catch (err) {
    log.warn('shipping.cancel_failed', { orderId, err });
    await orderRef.update({ 'shipment.error': `Shiprocket cancel failed: ${String(err.message).slice(0, 200)} — cancel it in the Shiprocket panel` }).catch(() => {});
    return 'failed';
  }
}

/** Find the order a Shiprocket webhook refers to (by AWB, then by our order id). */
async function findOrderIdForWebhook({ awb, orderId }) {
  if (awb) {
    const q = await db.collection('orders').where('shipment.awb', '==', String(awb)).limit(1).get();
    if (!q.empty) return q.docs[0].id;
  }
  if (orderId && typeof orderId === 'string' && orderId.length <= 128 && !orderId.includes('/')) {
    const doc = await db.collection('orders').doc(orderId).get();
    if (doc.exists && doc.data().shipment?.provider === PROVIDER) return doc.id;
  }
  return null;
}

/** Customer-safe view of a shipment. */
function publicShipment(sh) {
  if (!sh || !sh.provider) return null;
  return {
    provider: sh.provider,
    state: sh.state || null,
    awb: sh.awb || null,
    courierName: sh.courierName || null,
    courierStatus: sh.courierStatus || null,
    trackUrl: sh.trackUrl || (sh.awb ? `https://shiprocket.co/tracking/${sh.awb}` : null),
    etd: sh.etd || null,
    exception: sh.exception || null,
    ndr: sh.ndr ? { status: sh.ndr.status, count: sh.ndr.count } : null,
    activities: sh.activities || [],
  };
}

module.exports = {
  PROVIDER,
  SHIPPABLE_STATES,
  ShippingError,
  mapCourierStatus,
  canAdvance,
  createShipmentForOrder,
  autoCreateShipment,
  retryFailedShipments,
  previewPackage,
  listCouriers,
  pickExpressCourier,
  cancelShipmentForOrder,
  shipOrder,
  applyTrackingUpdate,
  refreshTracking,
  findOrderIdForWebhook,
  publicShipment,
};
