/**
 * shippingController.js — Shiprocket fulfilment endpoints.
 *
 * Staff:    create shipment, list couriers, ship (AWB + pickup + label), sync tracking
 * Customer: read tracking for their own order
 * Shiprocket: status webhook (authenticated with the x-api-key token configured
 *             in the Shiprocket panel → Settings → API → Webhooks)
 */
'use strict';

const crypto = require('crypto');
const db = require('../config/firebase');
const log = require('../lib/logger');
const shiprocket = require('../services/shiprocketService');
const shipping = require('../services/shippingService');
const packaging = require('../services/packageService');
const { createNotification } = require('./notificationController');
const { sendOrderEmail } = require('./orderController');
const { createAuditLog } = require('../services/auditService');

const TRACKING_STALE_MS = 30 * 60 * 1000;

const ALERT_TEXT = {
  ndr: (o) => ['Delivery attempt failed', `Courier could not deliver order ${o}. Call the customer, then re-attempt or update the address in Shiprocket → NDR.`],
  rto: (o) => ['Order returning to origin', `Order ${o} is being returned (RTO). Refund the customer once the parcel is back and checked.`],
  rto_delivered: (o) => ['Returned parcel received', `Order ${o} is back at your pickup address. Inspect it, then refund the order to restock.`],
  lost: (o) => ['Parcel lost / damaged', `Courier reported order ${o} as lost or damaged. Raise a claim in Shiprocket and refund the customer.`],
  cancelled: (o) => ['Shipment cancelled', `Order ${o}'s Shiprocket shipment was cancelled.`],
  exception: (o) => ['Courier exception', `Order ${o} has a courier exception — check Shiprocket.`],
};

/** Email + in-app notifications for a courier-driven status change or exception. */
function notifyStatusChange(orderId, change) {
  if (!change) return;
  const short = `#${orderId.slice(-6).toUpperCase()}`;
  if (change.to) {
    const label = change.to.replace(/_/g, ' ');
    sendOrderEmail(orderId, 'status', { status: change.to });
    ['admin', 'staff'].forEach((target) => {
      createNotification(target, 'Order Status Updated', `Order ${short} is now ${label} (Shiprocket)`);
    });
    if (change.order?.userId) {
      createNotification(change.order.userId, 'Order Update', `Your order ${short} is now ${label}`);
    }
  }
  if (change.alert && ALERT_TEXT[change.alert]) {
    const [title, body] = ALERT_TEXT[change.alert](short);
    ['admin', 'staff'].forEach((target) => createNotification(target, title, body));
    if (change.alert === 'ndr' && change.order?.userId) {
      createNotification(change.order.userId, 'Delivery attempt missed',
        `The courier couldn't deliver order ${short}. Please keep your phone reachable — they will try again.`);
    }
  }
}
exports.notifyStatusChange = notifyStatusChange;

function sendError(res, req, err, event) {
  if (err?.code === 'BAD_PACKAGE') {
    return res.status(400).json({ success: false, error: err.message, code: err.code });
  }
  if (err instanceof shipping.ShippingError) {
    return res.status(err.status).json({ success: false, error: err.message, code: err.code });
  }
  if (err instanceof shiprocket.ShiprocketError) {
    log.warn(event, { requestId: req.id, orderId: req.params.id, err });
    return res.status(502).json({ success: false, error: err.message });
  }
  log.error(event, { requestId: req.id, orderId: req.params.id, err });
  return res.status(500).json({ success: false, error: 'Shipping request failed' });
}

/** GET /api/shipping/status — is the integration configured? (staff) */
exports.getStatus = (req, res) => res.status(200).json({
  success: true,
  data: {
    enabled: shiprocket.isEnabled(),
    autoCreate: process.env.SHIPROCKET_AUTO_CREATE !== 'false',
    pickupPincode: process.env.SHIPROCKET_PICKUP_PINCODE || null,
    auth: shiprocket.authStatus(),
  },
});

/**
 * POST /api/shipping/status/test-login — clear the login pause and try ONE
 * login (max once a minute). Use after fixing credentials / unblocking. (admin)
 */
exports.testLogin = async (req, res) => {
  try {
    const auth = await shiprocket.testLogin();
    createAuditLog({
      adminId: req.user.uid, adminEmail: req.user.email || 'unknown', action: 'SHIPROCKET_TEST_LOGIN',
      resourceId: 'shiprocket', previousState: null, newState: { ok: true }, ipAddress: req.ip,
    });
    return res.status(200).json({ success: true, data: auth });
  } catch (err) {
    if (err instanceof shiprocket.ShiprocketError) {
      return res.status(err.status === 429 ? 429 : 502).json({ success: false, error: err.message, data: shiprocket.authStatus() });
    }
    return sendError(res, req, err, 'shipping.test_login_failed');
  }
};

/* ── packaging (box catalogue) ─────────────────────────────────────────── */

/** GET /api/shipping/packaging — box catalogue + packing rules (staff: read for the order panel) */
exports.getPackaging = async (req, res) => {
  try {
    const data = await packaging.getPackagingSettings({ fresh: true });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, req, err, 'shipping.packaging_get_failed');
  }
};

/** PUT /api/shipping/packaging — save box catalogue + packing rules (admin) */
exports.updatePackaging = async (req, res) => {
  let data;
  try {
    data = await packaging.savePackagingSettings(req.body || {}, { by: req.user.email || req.user.uid });
  } catch (err) {
    return sendError(res, req, err, 'shipping.packaging_save_failed');
  }
  createAuditLog({
    adminId: req.user.uid,
    adminEmail: req.user.email || 'unknown',
    action: 'UPDATE_SHIPPING_PACKAGING',
    resourceId: 'packaging',
    previousState: null,
    newState: { boxes: data.boxes.map((b) => `${b.id} ${b.length}x${b.breadth}x${b.height}`) },
    ipAddress: req.ip,
  });
  return res.status(200).json({ success: true, data });
};

/**
 * GET /api/shipping/orders/:id/package?boxId=BX-M | ?length=&breadth=&height=&weightKg=
 * Preview the parcel for an order (auto box, or the given override). (staff)
 */
exports.getPackage = async (req, res) => {
  try {
    const override = packaging.parseOverride(req.query);
    const data = await shipping.previewPackage(req.params.id, override);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, req, err, 'shipping.package_preview_failed');
  }
};

/**
 * POST /api/shipping/orders/:id/create — push the order to Shiprocket (staff)
 * Body (optional): { package: { boxId } | { length, breadth, height }, + weightKg? }
 */
exports.createShipment = async (req, res) => {
  try {
    const packageOverride = packaging.parseOverride(req.body?.package);
    const shipment = await shipping.createShipmentForOrder(req.params.id, {
      source: req.user.email || req.user.uid,
      packageOverride,
      force: req.body?.force === true, // ship a local-partner order via Shiprocket anyway
    });
    createAuditLog({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: 'SHIPROCKET_CREATE_SHIPMENT',
      resourceId: req.params.id,
      previousState: null,
      newState: { shipmentId: shipment.shipmentId, package: shipment.package || null, forced: req.body?.force === true },
      ipAddress: req.ip,
    });
    return res.status(200).json({ success: true, data: shipment });
  } catch (err) {
    return sendError(res, req, err, 'shipping.create_failed');
  }
};

/** GET /api/shipping/orders/:id/couriers — courier options + rates (staff) */
exports.getCouriers = async (req, res) => {
  try {
    const data = await shipping.listCouriers(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, req, err, 'shipping.couriers_failed');
  }
};

/** POST /api/shipping/orders/:id/ship  { courierId? } — AWB + pickup + label (staff) */
exports.shipOrder = async (req, res) => {
  try {
    const courierId = req.body?.courierId != null ? Number(req.body.courierId) : undefined;
    if (courierId !== undefined && !Number.isInteger(courierId)) {
      return res.status(400).json({ success: false, error: 'Invalid courierId' });
    }
    const { shipment, statusChange } = await shipping.shipOrder(req.params.id, { courierId });
    createAuditLog({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: 'SHIPROCKET_SHIP_ORDER',
      resourceId: req.params.id,
      previousState: statusChange ? { status: statusChange.from } : null,
      newState: { awb: shipment.awb, courier: shipment.courierName },
      ipAddress: req.ip,
    });
    notifyStatusChange(req.params.id, statusChange);
    return res.status(200).json({ success: true, data: shipment });
  } catch (err) {
    return sendError(res, req, err, 'shipping.ship_failed');
  }
};

/**
 * POST /api/shipping/retry-failed — re-push paid orders whose automatic
 * Shiprocket push failed (cron or admin). Also runs in-process every 15 min.
 */
exports.retryFailed = async (req, res) => {
  try {
    const data = await runShipmentRetry();
    return res.status(200).json({ success: true, data });
  } catch (err) {
    return sendError(res, req, err, 'shipping.retry_failed');
  }
};

/** Shared by the route and the in-process scheduler. */
async function runShipmentRetry() {
  const result = await shipping.retryFailedShipments({
    onGiveUp: (orderId, error) => {
      const short = `#${orderId.slice(-6).toUpperCase()}`;
      createNotification('admin', 'Shiprocket push failed',
        `Order ${short} could not be pushed to Shiprocket after 3 attempts: ${error}. Push it manually from Orders.`);
    },
  });
  if (result.retried) log.info('shipping.retry_run', result);
  return result;
}
exports.runShipmentRetry = runShipmentRetry;

/** POST /api/shipping/orders/:id/sync — pull latest tracking now (staff) */
exports.syncTracking = async (req, res) => {
  try {
    const change = await shipping.refreshTracking(req.params.id);
    notifyStatusChange(req.params.id, change);
    const snap = await db.collection('orders').doc(req.params.id).get();
    return res.status(200).json({
      success: true,
      data: { status: snap.data().status, shipment: snap.data().shipment },
    });
  } catch (err) {
    return sendError(res, req, err, 'shipping.sync_failed');
  }
};

/** GET /api/shipping/track/:id — tracking for the customer's own order (or staff) */
exports.getTracking = async (req, res) => {
  try {
    const ref = db.collection('orders').doc(req.params.id);
    let snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Order not found' });
    const order = snap.data();
    const privileged = ['admin', 'staff'].includes(req.user?.role);
    if (!privileged && order.userId !== req.user.uid) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    // Lazily refresh stale tracking so the page stays current even if a webhook was missed.
    const sh = order.shipment || {};
    const lastSync = sh.lastSyncedAt?.toMillis ? sh.lastSyncedAt.toMillis() : 0;
    const live = ['awb_assigned', 'pickup_scheduled', 'in_transit', 'rto_in_transit'].includes(sh.state);
    if (shiprocket.isEnabled() && sh.awb && live && Date.now() - lastSync > TRACKING_STALE_MS) {
      try {
        notifyStatusChange(req.params.id, await shipping.refreshTracking(req.params.id));
        snap = await ref.get();
      } catch (err) {
        log.warn('shipping.lazy_refresh_failed', { requestId: req.id, orderId: req.params.id, err });
      }
    }

    return res.status(200).json({
      success: true,
      data: { status: snap.data().status, shipment: shipping.publicShipment(snap.data().shipment) },
    });
  } catch (err) {
    return sendError(res, req, err, 'shipping.track_failed');
  }
};

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  // Trim: tokens pasted into the Shiprocket panel / .env often carry stray whitespace.
  const a = Buffer.from(String(provided).trim());
  const b = Buffer.from(String(expected).trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST /api/shipping/webhook — Shiprocket shipment status push.
 * Always answers 200 for authenticated calls (Shiprocket disables webhooks that
 * keep failing); unknown AWBs are logged and ignored.
 */
exports.webhook = async (req, res) => {
  const expected = process.env.SHIPROCKET_WEBHOOK_TOKEN;
  if (!expected) {
    log.warn('shipping.webhook_not_configured', { requestId: req.id });
    return res.status(503).json({ success: false, error: 'Webhook not configured' });
  }
  if (!tokenMatches(req.headers['x-api-key'], expected)) {
    // Never log the token itself — only enough to tell "missing" from "wrong".
    const got = String(req.headers['x-api-key'] || '').trim();
    log.warn('shipping.webhook_bad_token', {
      requestId: req.id,
      headerPresent: !!got,
      receivedLength: got.length,
      expectedLength: String(expected).trim().length,
      contentType: req.headers['content-type'] || null,
    });
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const p = req.body || {};
    if (Number(p.is_return) === 1) return res.status(200).json({ success: true, ignored: 'return shipment' });

    const orderId = await shipping.findOrderIdForWebhook({ awb: p.awb, orderId: p.order_id });
    if (!orderId) {
      log.warn('shipping.webhook_unknown_order', { requestId: req.id, awb: p.awb, srOrderId: p.sr_order_id });
      return res.status(200).json({ success: true, ignored: 'unknown order' });
    }

    const activities = Array.isArray(p.scans)
      ? p.scans.slice().reverse().slice(0, 25).map((s) => ({
        date: s.date || null,
        status: s['sr-status-label'] || s.status || '',
        activity: s.activity || '',
        location: s.location || '',
      }))
      : undefined;

    const change = await shipping.applyTrackingUpdate(orderId, {
      courierStatus: p.current_status || p.shipment_status,
      etd: p.etd,
      awb: p.awb,
      courierName: p.courier_name,
      activities,
    });
    log.info('shipping.webhook_applied', { requestId: req.id, orderId, courierStatus: p.current_status, changedTo: change?.to || null });
    notifyStatusChange(orderId, change);
    return res.status(200).json({ success: true });
  } catch (err) {
    log.error('shipping.webhook_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Webhook processing failed' });
  }
};
