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
const { createNotification } = require('./notificationController');
const { sendOrderEmail } = require('./orderController');
const { createAuditLog } = require('../services/auditService');

const TRACKING_STALE_MS = 30 * 60 * 1000;

/** Email + in-app notifications for a courier-driven status change. */
function notifyStatusChange(orderId, change) {
  if (!change) return;
  const short = `#${orderId.slice(-6).toUpperCase()}`;
  const label = change.to.replace(/_/g, ' ');
  sendOrderEmail(orderId, 'status', { status: change.to });
  ['admin', 'staff'].forEach((target) => {
    createNotification(target, 'Order Status Updated', `Order ${short} is now ${label} (Shiprocket)`);
  });
  if (change.order?.userId) {
    createNotification(change.order.userId, 'Order Update', `Your order ${short} is now ${label}`);
  }
}

function sendError(res, req, err, event) {
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
  },
});

/** POST /api/shipping/orders/:id/create — push the order to Shiprocket (staff) */
exports.createShipment = async (req, res) => {
  try {
    const shipment = await shipping.createShipmentForOrder(req.params.id, { source: req.user.email || req.user.uid });
    createAuditLog({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: 'SHIPROCKET_CREATE_SHIPMENT',
      resourceId: req.params.id,
      previousState: null,
      newState: { shipmentId: shipment.shipmentId },
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
    const live = ['awb_assigned', 'pickup_scheduled', 'in_transit'].includes(sh.state);
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
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
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
    log.warn('shipping.webhook_bad_token', { requestId: req.id });
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
