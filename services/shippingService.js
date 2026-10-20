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
 */
'use strict';

const admin = require('firebase-admin');
const db = require('../config/firebase');
const log = require('../lib/logger');
const shiprocket = require('./shiprocketService');
const { ORDER_TRANSITIONS } = require('../config/constants');

const PROVIDER = 'shiprocket';

/** Order states from which a shipment may be created. */
const SHIPPABLE_STATES = Object.freeze(['pending', 'processing', 'packed', 'payment_successful_no_stock']);

const FLOW = ['pending', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered'];
const flowRank = (s) => (s === 'payment_successful_no_stock' ? 0 : FLOW.indexOf(s));

/**
 * Map a Shiprocket shipment status label to an Alimenture order status.
 * Returns { status: string|null, exception: boolean }.
 */
function mapCourierStatus(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/_/g, ' ');
  if (!s) return { status: null, exception: false };
  if (/^RTO|UNDELIVERED|LOST|DAMAGED|DESTROYED|CANCEL|DISPOSED|MISROUTED/.test(s) || s.includes('RTO')) {
    return { status: null, exception: true };
  }
  if (s === 'DELIVERED') return { status: 'delivered', exception: false };
  if (s.includes('OUT FOR DELIVERY')) return { status: 'out_for_delivery', exception: false };
  if (/PICKED UP|SHIPPED|IN TRANSIT|REACHED|DESTINATION HUB|AT HUB|DELAYED/.test(s)) {
    return { status: 'shipped', exception: false };
  }
  if (/PICKUP|MANIFEST|AWB|LABEL|READY TO SHIP/.test(s)) return { status: 'packed', exception: false };
  return { status: null, exception: false };
}

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
 */
async function createShipmentForOrder(orderId, { source = 'admin' } = {}) {
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
    const claimAt = sh.claimedAt?.toMillis ? sh.claimedAt.toMillis() : 0;
    if (sh.state === 'creating' && Date.now() - claimAt < CLAIM_TTL_MS) {
      throw new ShippingError('BUSY', 'Shipment creation already in progress', 409);
    }
    t.update(orderRef, {
      shipment: { provider: PROVIDER, state: 'creating', claimedAt: admin.firestore.Timestamp.now() },
      updatedAt: now(),
    });
    return { order };
  });
  if (claimed.existing) return claimed.existing;

  const ci = claimed.order.customerInfo || {};
  if (!ci.pincode || !ci.state || !ci.phone) {
    await orderRef.update({
      shipment: { provider: PROVIDER, state: 'failed', error: 'Address is missing PIN code, state or phone', updatedAt: admin.firestore.Timestamp.now() },
    });
    throw new ShippingError('INCOMPLETE_ADDRESS', 'Order address is missing PIN code, state or phone number');
  }

  try {
    const created = await shiprocket.createOrder(orderId, claimed.order);
    const shipment = {
      provider: PROVIDER,
      state: 'created',
      srOrderId: created.srOrderId,
      shipmentId: created.shipmentId,
      courierStatus: created.srStatus,
      weightKg: created.weightKg,
      createdAt: admin.firestore.Timestamp.now(),
      createdBy: source,
    };
    await orderRef.update({ shipment, updatedAt: now() });
    log.info('shipping.order_created', { orderId, shipmentId: created.shipmentId, source });
    return shipment;
  } catch (err) {
    await orderRef.update({
      shipment: { provider: PROVIDER, state: 'failed', error: String(err.message).slice(0, 300), updatedAt: admin.firestore.Timestamp.now() },
    }).catch(() => {});
    throw err;
  }
}

/** Fire-and-forget hook used after payment confirmation. Never throws. */
async function autoCreateShipment(orderId) {
  if (!shiprocket.isEnabled() || process.env.SHIPROCKET_AUTO_CREATE === 'false') return;
  try {
    await createShipmentForOrder(orderId, { source: 'auto' });
  } catch (err) {
    log.warn('shipping.auto_create_failed', { orderId, err });
  }
}

/* ── 2. courier + pickup ───────────────────────────────────────────────── */

async function listCouriers(orderId) {
  assertEnabled();
  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  const sh = snap.data().shipment || {};
  if (!sh.srOrderId) throw new ShippingError('NO_SHIPMENT', 'Create the Shiprocket shipment first');
  return shiprocket.checkServiceability({ srOrderId: sh.srOrderId });
}

/**
 * Assign AWB (chosen or recommended courier), request pickup and fetch the
 * label. Each step is persisted as it completes, so a retry resumes where the
 * previous attempt stopped. Moves the order to `packed`.
 * @returns {{ shipment, statusChange: { from, to }|null }}
 */
async function shipOrder(orderId, { courierId } = {}) {
  assertEnabled();
  const orderRef = db.collection('orders').doc(orderId);
  let snap = await orderRef.get();
  if (!snap.exists) throw new ShippingError('NOT_FOUND', 'Order not found', 404);
  let sh = snap.data().shipment || {};

  if (!sh.shipmentId) {
    sh = await createShipmentForOrder(orderId);
  }

  const patch = {};
  if (!sh.awb) {
    const awb = await shiprocket.assignAwb(sh.shipmentId, courierId ? Number(courierId) : undefined);
    Object.assign(patch, {
      'shipment.awb': awb.awb,
      'shipment.courierId': awb.courierId || null,
      'shipment.courierName': awb.courierName || null,
      'shipment.state': 'awb_assigned',
      'shipment.awbAssignedAt': admin.firestore.Timestamp.now(),
      'shipment.error': admin.firestore.FieldValue.delete(),
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
 * @returns {Promise<{ from: string, to: string, order: object }|null>} the status change, if any
 */
async function applyTrackingUpdate(orderId, {
  courierStatus, etd, trackUrl, activities, awb, courierName, forceStatus,
} = {}) {
  const orderRef = db.collection('orders').doc(orderId);
  return db.runTransaction(async (t) => {
    const snap = await t.get(orderRef);
    if (!snap.exists) return null;
    const order = snap.data();

    const mapped = forceStatus ? { status: forceStatus, exception: false } : mapCourierStatus(courierStatus);
    const update = { updatedAt: now(), 'shipment.lastSyncedAt': admin.firestore.Timestamp.now() };
    if (courierStatus) update['shipment.courierStatus'] = String(courierStatus).toUpperCase();
    if (etd) update['shipment.etd'] = String(etd);
    if (trackUrl) update['shipment.trackUrl'] = trackUrl;
    if (awb && !order.shipment?.awb) update['shipment.awb'] = String(awb);
    if (courierName && !order.shipment?.courierName) update['shipment.courierName'] = courierName;
    if (Array.isArray(activities) && activities.length) update['shipment.activities'] = activities.slice(0, 25);
    if (mapped.exception) {
      update['shipment.exception'] = String(courierStatus).toUpperCase();
    } else if (mapped.status) {
      update['shipment.exception'] = admin.firestore.FieldValue.delete();
    }
    if (mapped.status === 'delivered') update['shipment.state'] = 'delivered';
    else if (mapped.status === 'shipped' || mapped.status === 'out_for_delivery') update['shipment.state'] = 'in_transit';

    let change = null;
    if (canAdvance(order.status, mapped.status)) {
      update.status = mapped.status;
      if (mapped.status === 'delivered') update.deliveredAt = now();
      change = { from: order.status, to: mapped.status, order };
    }
    t.update(orderRef, update);
    return change;
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
  listCouriers,
  shipOrder,
  applyTrackingUpdate,
  refreshTracking,
  findOrderIdForWebhook,
  publicShipment,
};
