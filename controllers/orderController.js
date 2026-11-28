const admin = require('../lib/firebaseAdmin');
const db = require("../config/firebase");
const { sendMail } = require('../utils/mailer');
const { buildOrderEmail, buildAdminOrderAlert, buildOtpEmail } = require('../utils/emailTemplates');
const { issueOtp, verifyOtp, OTP_ERROR_MESSAGE } = require('../utils/otp');
const whatsapp = require('../services/whatsappService');
const { buildInvoicePdf } = require('../utils/invoicePdf');
const { computeDeliveryFee, isValidPincode, DeliveryError, getPincodeRule, partnerOf, courierRateFor } = require('../services/deliveryService');
const { autoCreateShipment, cancelShipmentForOrder, publicShipment } = require('../services/shippingService');
const { variantShipping, quotePackage, packageSnapshot, getPackagingSettings, OVERSIZE_MESSAGE } = require('../services/packageService');
const { buildInitialShipping } = require('../models/orderShipping');
const { DELIVERY_METHODS } = require('../config/deliveryConstants');
const { createNotification } = require('./notificationController');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { incrementSalesAnalytics, decrementSalesAnalytics } = require("../services/analyticsService");
const { createAuditLog } = require('../services/auditService');
const {
  ORDER_TRANSITIONS,
  REFUNDABLE_STATES,
  LIMITS,
} = require('../config/constants');
const log = require('../lib/logger');
const { runOrdered } = require('../lib/resilientQuery');

// Every order transaction can move stock (reserve, release, cancel, refund), so
// drop the product cache afterwards — the storefront then shows fresh stock
// without polling Firestore every minute. Lazy require avoids a load cycle.
const runStockTxn = async (fn) => {
  const result = await db.runTransaction(fn);
  require('./productController').invalidateProductCache();
  return result;
};

const LIST_LIMIT_MAX = LIMITS.LIST_LIMIT_MAX;

const couponRedemptionId = (couponId, uid) => `${couponId}_${uid}`;

/**
 * Send a branded transactional email for an order lifecycle event.
 * Fire-and-forget — never throws, never blocks the response.
 * `kind`: 'placed' | 'paid' | 'status' | 'cancelled' | 'refunded'.
 * On delivery a modern PDF invoice is generated and attached.
 */
async function sendOrderEmail(orderId, kind, extra = {}) {
  try {
    const snap = await db.collection('orders').doc(orderId).get();
    if (!snap.exists) return;
    const order = snap.data();
    // WhatsApp the customer on the same status changes they're emailed about.
    if (kind === 'status' || kind === 'cancelled' || kind === 'refunded') {
      whatsapp.notifyStatus(orderId, order, kind === 'status' ? extra.status : kind).catch(() => {});
    }
    const to = order.customerInfo && order.customerInfo.email;
    if (!to) return;

    const { subject, text, html, attachments } = buildOrderEmail({ order, orderId, kind, ...extra });
    const atts = Array.isArray(attachments) ? [...attachments] : [];

    if (kind === 'status' && extra.status === 'delivered') {
      try {
        const pdf = await buildInvoicePdf(order, orderId);
        atts.push({
          filename: `Alimenture-Invoice-${String(orderId).slice(-8).toUpperCase()}.pdf`,
          content: pdf,
          contentType: 'application/pdf',
        });
      } catch (err) {
        log.warn('order.invoice_pdf_failed', { orderId, err });
      }
    }

    await sendMail(to, subject, text, html, atts);
  } catch (err) {
    log.warn('order.email_failed', { orderId, kind, err });
  }
}
exports.sendOrderEmail = sendOrderEmail; // reused by the Shiprocket tracking flow

/** Comma-separated team inboxes for new-order alerts (ORDER_ALERT_EMAILS). */
const orderAlertEmails = () => String(process.env.ORDER_ALERT_EMAILS || '')
  .split(',').map((e) => e.trim()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

/**
 * A payment was just confirmed: email the full order to the shop team and
 * send the WhatsApp alerts. Fire-and-forget — never throws.
 */
async function alertTeamOfPaidOrder(orderId) {
  try {
    const snap = await db.collection('orders').doc(orderId).get();
    if (!snap.exists) return;
    const order = snap.data();
    const inStock = order.status !== 'payment_successful_no_stock';
    const to = orderAlertEmails();
    const jobs = [whatsapp.notifyPaidOrder(orderId, order, { inStock })];
    if (to.length) {
      const { subject, text, html } = buildAdminOrderAlert({ order, orderId });
      jobs.push(sendMail(to.join(','), inStock ? subject : `⚠ OUT OF STOCK — ${subject}`, text, html));
    }
    await Promise.allSettled(jobs);
  } catch (err) {
    log.warn('order.team_alert_failed', { orderId, err });
  }
}

function computeDiscount(coupon, subtotal) {
  if (coupon.discountType === 'percentage') {
    return Math.round((subtotal * coupon.discountValue) / 100);
  }
  return Math.min(coupon.discountValue, subtotal);
}

/**
 * Atomically consume a coupon for a user inside an existing transaction.
 * MUST have already t.get() any product refs first (Firestore txn: reads before writes).
 * @returns {{ discountAmount, couponId, couponCode }}
 * @throws Error('COUPON_INVALID') | Error('COUPON_LIMIT') | Error('COUPON_ALREADY_USED')
 */
async function consumeCouponInTxn(t, { couponRef, uid, subtotal, pending = false }) {
  const snap = await t.get(couponRef);
  if (!snap.exists) throw new Error('COUPON_INVALID');
  const coupon = snap.data();

  const isExpired = coupon.expiresAt &&
    new Date(coupon.expiresAt.toDate ? coupon.expiresAt.toDate() : coupon.expiresAt) < new Date();
  if (!coupon.isActive || isExpired) throw new Error('COUPON_INVALID');
  if (coupon.assignedTo && coupon.assignedTo !== uid) throw new Error('COUPON_INVALID'); // personal coupon
  if (subtotal < (coupon.minOrderValue || 0)) throw new Error('COUPON_INVALID');
  if ((coupon.usedCount || 0) >= (coupon.maxUsage || 1)) throw new Error('COUPON_LIMIT');

  const redemptionRef = db.collection('couponRedemptions').doc(couponRedemptionId(couponRef.id, uid));
  const existing = await t.get(redemptionRef);
  if (existing.exists) throw new Error('COUPON_ALREADY_USED');

  t.create(redemptionRef, {
    couponId: couponRef.id,
    code: coupon.code,
    userId: uid,
    // For Razorpay the redemption is provisional until payment succeeds; it is
    // released (deleted + usedCount decremented) if the payment never completes.
    pending: !!pending,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  t.update(couponRef, { usedCount: admin.firestore.FieldValue.increment(1) });

  return {
    discountAmount: computeDiscount(coupon, subtotal),
    couponId: couponRef.id,
    couponCode: coupon.code,
  };
}

/**
 * Finalise a coupon redemption once a Razorpay order is PAID — split into a READ
 * and a WRITE half because Firestore transactions must do every read before the
 * first write (the SDK throws otherwise). The redemption was normally created
 * (provisionally) with the order, so this just clears `pending`; if it was
 * released meanwhile (abandoned/expired checkout that was paid late) it is
 * recorded again. Tolerates a deleted coupon.
 */
async function readCouponConfirm(t, oData) {
  if (!oData.couponId || !oData.userId) return null;
  const redemptionRef = db.collection('couponRedemptions').doc(couponRedemptionId(oData.couponId, oData.userId));
  const couponRef = db.collection('coupons').doc(oData.couponId);
  const [rSnap, cSnap] = await Promise.all([t.get(redemptionRef), t.get(couponRef)]);
  return {
    oData, redemptionRef, couponRef,
    redemptionExists: rSnap.exists,
    redemptionPending: rSnap.exists && !!rSnap.data().pending,
    couponExists: cSnap.exists,
  };
}

function applyCouponConfirm(t, c) {
  if (!c) return;
  if (c.redemptionExists) {
    if (c.redemptionPending) {
      t.update(c.redemptionRef, { pending: false, confirmedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    return;
  }
  t.create(c.redemptionRef, {
    couponId: c.oData.couponId,
    code: c.oData.couponCode || null,
    userId: c.oData.userId,
    pending: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  if (c.couponExists) {
    t.update(c.couponRef, { usedCount: admin.firestore.FieldValue.increment(1) });
  }
}

/**
 * An order the system cancelled only because its payment window lapsed (customer
 * closed the Razorpay window, or the 10-minute reservation expired). If Razorpay
 * then captures a payment for it — slow UPI/netbanking — it must be revived, not
 * left cancelled with the customer's money taken.
 */
const LATE_PAYMENT_CANCEL_REASONS = ['payment_window_expired', 'reservation_released'];
const isRevivableCancelledOrder = (o) => !!o
  && o.status === 'cancelled'
  && !o.razorpayPaymentId
  && LATE_PAYMENT_CANCEL_REASONS.includes(o.cancelReason);

/**
 * Read (inside a txn) whether every line of an order can be taken from stock
 * again. Variants are tracked per product so two lines of the same product
 * (different sizes) are both counted.
 */
async function readRestock(t, items = []) {
  const byProduct = new Map(); // productId -> { ref, variants, qty }
  for (const item of items) {
    if (!byProduct.has(item.productId)) {
      const ref = db.collection('products').doc(item.productId);
      const snap = await t.get(ref);
      byProduct.set(item.productId, { ref, exists: snap.exists, variants: snap.exists ? (snap.data().variants || []).map((v) => ({ ...v })) : [], qty: 0 });
    }
  }
  let available = true;
  for (const item of items) {
    const p = byProduct.get(item.productId);
    if (!p.exists) { available = false; continue; }
    let idx = p.variants.findIndex((v) => v.weight === item.selectedWeight);
    if (idx === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight) && p.variants.length > 0) idx = 0;
    const qty = Number(item.quantity) || 0;
    if (idx === -1 || Number(p.variants[idx].stock) < qty) { available = false; continue; }
    p.variants[idx].stock = Number(p.variants[idx].stock) - qty;
    p.qty += qty;
  }
  return { available, byProduct };
}

function applyRestockTake(t, restock) {
  for (const [, p] of restock.byProduct) {
    if (!p.exists || !p.qty) continue;
    t.update(p.ref, { variants: p.variants, stock: admin.firestore.FieldValue.increment(-p.qty) });
  }
}

/**
 * Release a provisional (or any) coupon redemption for a user — used when a
 * Razorpay checkout is abandoned or its gateway order fails. Runs in its own
 * transaction; all reads precede all writes.
 */
async function releaseCoupon(couponId, uid) {
  if (!couponId || !uid) return;
  try {
    await runStockTxn(async (t) => {
      const redemptionRef = db.collection('couponRedemptions').doc(couponRedemptionId(couponId, uid));
      const couponRef = db.collection('coupons').doc(couponId);
      const [rSnap, cSnap] = await Promise.all([t.get(redemptionRef), t.get(couponRef)]);
      if (!rSnap.exists) return;
      t.delete(redemptionRef);
      if (cSnap.exists && (cSnap.data().usedCount || 0) > 0) {
        t.update(couponRef, { usedCount: admin.firestore.FieldValue.increment(-1) });
      }
    });
  } catch (err) {
    console.error('Failed to release coupon', couponId, uid, err);
  }
}

/**
 * READ phase for reversing an order (cancel / refund). Firestore requires all
 * reads before all writes, so callers must:
 *   1. do their own order/status reads
 *   2. `const rev = await readOrderReversal(t, oData)`
 *   3. do their writes (status change, etc.)
 *   4. `applyOrderReversal(t, oData, rev)`
 *   5. `decrementSalesAnalytics(t, ...)` if applicable (write-only)
 */
async function readOrderReversal(t, oData) {
  const productUpdates = new Map();
  const missing = new Set();
  for (const item of oData.items || []) {
    if (missing.has(item.productId)) continue;
    // One read per product; later lines of the same product reuse that copy.
    let entry = productUpdates.get(item.productId);
    if (!entry) {
      const productRef = db.collection("products").doc(item.productId);
      const productDoc = await t.get(productRef);
      if (!productDoc.exists) { missing.add(item.productId); continue; }
      entry = { ref: productRef, variants: productDoc.data().variants || [], quantityChange: 0 };
    }
    const { variants } = entry;
    let idx = variants.findIndex((v) => v.weight === item.selectedWeight);
    if (idx === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight) && variants.length > 0) idx = 0;
    if (idx === -1) continue;
    variants[idx].stock = Number(variants[idx].stock) + Number(item.quantity);
    entry.quantityChange += Number(item.quantity);
    productUpdates.set(item.productId, entry);
  }

  let coupon = null;
  if (oData.couponId && oData.userId) {
    const couponRef = db.collection('coupons').doc(oData.couponId);
    const redemptionRef = db.collection('couponRedemptions').doc(couponRedemptionId(oData.couponId, oData.userId));
    const [couponSnap, redemptionSnap] = await Promise.all([t.get(couponRef), t.get(redemptionRef)]);
    coupon = {
      couponRef,
      redemptionRef,
      usedCount: couponSnap.exists ? (couponSnap.data().usedCount || 0) : 0,
      redemptionExists: redemptionSnap.exists,
    };
  }

  return { productUpdates, coupon };
}

/** WRITE phase — restock, release reservation, release coupon. */
function applyOrderReversal(t, oData, rev) {
  for (const [, u] of rev.productUpdates) {
    t.update(u.ref, {
      variants: u.variants,
      stock: admin.firestore.FieldValue.increment(u.quantityChange),
    });
  }
  if (oData.reservationId) {
    t.update(db.collection("stockReservations").doc(oData.reservationId), {
      status: 'CANCELLED_AND_RETURNED',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  if (rev.coupon && rev.coupon.redemptionExists) {
    t.delete(rev.coupon.redemptionRef);
    if (rev.coupon.usedCount > 0) {
      t.update(rev.coupon.couponRef, { usedCount: admin.firestore.FieldValue.increment(-1) });
    }
  }
}

const releaseReservation = async (reservationId, status = 'RELEASED') => {
  try {
    await runStockTxn(async (t) => {
      const resRef = db.collection("stockReservations").doc(reservationId);
      const resDoc = await t.get(resRef);
      if (!resDoc.exists) return;
      const data = resDoc.data();
      if (data.status !== 'ACTIVE') return;

      // ── ALL READS FIRST ──
      // Linked order (if any) — an unpaid Razorpay order whose window lapsed.
      let orderRef = null;
      let orderData = null;
      if (data.orderId) {
        orderRef = db.collection("orders").doc(data.orderId);
        const oDoc = await t.get(orderRef);
        if (oDoc.exists) orderData = oDoc.data();
      }
      const cancelOrphanOrder = !!(orderRef && orderData && orderData.status === 'payment_pending');

      // Coupon redemption tied to that order (read up-front so we can release it).
      let redemptionRef = null;
      let couponRefForRelease = null;
      let redemptionExists = false;
      let couponUsedCount = 0;
      if (cancelOrphanOrder && orderData.couponId && orderData.userId) {
        redemptionRef = db.collection('couponRedemptions').doc(couponRedemptionId(orderData.couponId, orderData.userId));
        couponRefForRelease = db.collection('coupons').doc(orderData.couponId);
        const [rSnap, cSnap] = await Promise.all([t.get(redemptionRef), t.get(couponRefForRelease)]);
        redemptionExists = rSnap.exists;
        couponUsedCount = cSnap.exists ? (cSnap.data().usedCount || 0) : 0;
      }

      const productUpdates = new Map();
      const snaps = new Map(); // one read per product (later lines reuse the copy)
      for (const item of data.items || []) {
        if (!snaps.has(item.productId)) {
          const productRef = db.collection("products").doc(item.productId);
          const productDoc = await t.get(productRef);
          snaps.set(item.productId, productDoc.exists ? { ref: productRef, variants: productDoc.data().variants || [] } : null);
        }
        const p = snaps.get(item.productId);
        if (!p) continue;
        let variantIndex = p.variants.findIndex(v => v.weight === item.selectedWeight);
        if (variantIndex === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight) && p.variants.length > 0) variantIndex = 0;
        if (variantIndex === -1) continue;
        p.variants[variantIndex].stock = Number(p.variants[variantIndex].stock) + Number(item.quantity);
        productUpdates.set(item.productId, {
          ref: p.ref,
          variants: p.variants,
          quantityChange: (productUpdates.get(item.productId)?.quantityChange || 0) + Number(item.quantity),
        });
      }

      // ── ALL WRITES ──
      for (const [, update] of productUpdates) {
        t.update(update.ref, {
          variants: update.variants,
          stock: admin.firestore.FieldValue.increment(update.quantityChange)
        });
      }
      t.update(resRef, { status: status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

      if (cancelOrphanOrder) {
        t.update(orderRef, {
          status: 'cancelled',
          cancelReason: status === 'EXPIRED' ? 'payment_window_expired' : 'reservation_released',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        if (redemptionExists) {
          t.delete(redemptionRef);
          if (couponUsedCount > 0) {
            t.update(couponRefForRelease, { usedCount: admin.firestore.FieldValue.increment(-1) });
          }
        }
      }
    });
  } catch (err) {
    console.error(`Failed to release reservation ${reservationId}:`, err);
  }
};

exports.cleanupExpiredReservations = async (req, res) => {
  try {
    const now = new Date();
    let docs;
    try {
      const snapshot = await db.collection("stockReservations")
        .where("status", "==", "ACTIVE")
        .where("expiresAt", "<", now)
        .limit(250) // bounded per run; the cron fires every 5 min
        .get();
      docs = snapshot.docs;
    } catch (err) {
      // Composite index (status + expiresAt, see firestore.indexes.json) not
      // deployed yet → without this fallback the cleanup silently never ran, so
      // abandoned checkouts kept stock locked forever.
      if (err.code !== 9) throw err;
      log.warn('cron.reservation_cleanup_index_missing');
      const snapshot = await db.collection("stockReservations").where("status", "==", "ACTIVE").limit(1000).get();
      const ms = (v) => (v?.toDate ? v.toDate() : new Date(v)).getTime();
      docs = snapshot.docs.filter((d) => d.data().expiresAt && ms(d.data().expiresAt) < now.getTime()).slice(0, 250);
    }

    let count = 0;
    for (const doc of docs) {
      const { orderId } = doc.data();
      if (orderId) {
        const oDoc = await db.collection("orders").doc(orderId).get();
        if (oDoc.exists && await reconcileRazorpayOrder(orderId, oDoc.data())) continue;
      }
      await releaseReservation(doc.id, 'EXPIRED');
      count++;
    }

    if (res) return res.status(200).json({ success: true, message: `Cleaned up ${count} expired reservations`, hasMore: count === 250 });
  } catch (err) {
    log.error('cron.reservation_cleanup_failed', { err });
    if (res) return res.status(500).json({ success: false, error: "Cleanup failed" });
  }
};

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

exports.getOrders = async (req, res) => {
  try {
    const { lastId, status, paymentMethod, search } = req.query;
    const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(req.query.limit) || 50));

    let filtered = db.collection("orders");
    if (status) {
       filtered = filtered.where("status", "==", status);
    }
    if (paymentMethod) {
       filtered = filtered.where("customerInfo.paymentMethod", "==", paymentMethod);
    }
    // Firestore lacks native full-text search without Algolia/Elasticsearch.
    // For simple prefix matching on email:
    if (search) {
       filtered = filtered.where("customerInfo.email", ">=", search)
                          .where("customerInfo.email", "<=", search + '\uf8ff');
    }

    let ordered = filtered.orderBy("createdAt", "desc").limit(limit);
    if (lastId) {
      const lastDoc = await db.collection("orders").doc(lastId).get();
      if (lastDoc.exists) ordered = ordered.startAfter(lastDoc);
    }

    // Fallback (composite index still building): unordered fetch + in-memory sort.
    const docs = await runOrdered(ordered, filtered.limit(500), {
      orderField: 'createdAt', dir: 'desc', limit, requestId: req.id,
    });
    const orders = docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Self-heal the dashboard: an order still shown "awaiting payment" (or
    // auto-cancelled in the last few days) may have been paid in Razorpay while
    // the verify call / webhook was lost. Check a bounded number per load.
    const toCheck = orders
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => o.razorpayOrderId && (o.status === 'payment_pending' || recentlyCancelledUnpaid(o)))
      .slice(0, 10);
    await mapLimit(toCheck, 4, async ({ o, i }) => {
      if (await reconcileRazorpayOrder(o.id, o, { includeCancelled: true })) {
        const fresh = await db.collection('orders').doc(o.id).get();
        if (fresh.exists) orders[i] = { id: o.id, ...fresh.data() };
      }
    });

    return res.status(200).json({
      success: true,
      count: orders.length,
      lastId: orders.length > 0 ? orders[orders.length - 1].id : null,
      hasMore: orders.length === limit,
      data: orders
    });
  } catch (err) {
    console.error("GET ORDERS ERROR:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch orders" });
  }
};

const isStaffRole = (user) => ['admin', 'staff'].includes(String(user?.role || '').toLowerCase());

/**
 * Customer view of an order: drops our courier cost / margin and internal
 * packing + shipment-ops fields. Staff and admin get the full document.
 */
function orderForViewer(order, user) {
  if (isStaffRole(user)) return order;
  // `logistics` holds freight costs, margins and packing data — staff only.
  const { estimatedShippingCost, quotedCourier, plannedPackage, reservationId, logistics, ...rest } = order;
  if (rest.shipment) rest.shipment = publicShipment(rest.shipment); // same allow-list as /shipping/track
  return rest;
}

async function ordersForEmail(email, req, res) {
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Number(req.query.limit) || 50));
  const filtered = db.collection("orders").where("customerInfo.email", "==", email);
  let ordered = filtered.orderBy("createdAt", "desc").limit(limit);
  if (req.query.lastId) {
    const lastDoc = await db.collection("orders").doc(req.query.lastId).get();
    if (lastDoc.exists) ordered = ordered.startAfter(lastDoc);
  }
  // Fallback path (composite index still building): fetch this user's orders
  // unordered (auto single-field index only) and sort in memory. Capped for safety.
  const docs = await runOrdered(ordered, filtered.limit(500), {
    orderField: 'createdAt', dir: 'desc', limit, requestId: req.id,
  });
  const orders = await Promise.all(docs.map(async (doc) => {
    const data = doc.data();
    if (await reconcileRazorpayOrder(doc.id, data)) {
      return orderForViewer({ id: doc.id, ...(await db.collection("orders").doc(doc.id).get()).data() }, req.user);
    }
    return orderForViewer({ id: doc.id, ...data }, req.user);
  }));
  return res.status(200).json({
    success: true,
    count: orders.length,
    lastId: orders.length ? orders[orders.length - 1].id : null,
    hasMore: orders.length === limit,
    data: orders,
  });
}

exports.getOrdersByEmail = async (req, res) => {
  try {
    const { email } = req.params;
    if (!email) return res.status(400).json({ success: false, error: "Email is required" });
    return await ordersForEmail(email, req, res);
  } catch (err) {
    log.error("order.by_email_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Failed to fetch orders" });
  }
};

exports.getMyOrders = async (req, res) => {
  try {
    if (!req.user.email) return res.status(400).json({ success: false, error: "User email not found in session" });
    return await ordersForEmail(req.user.email, req, res);
  } catch (err) {
    log.error("order.my_orders_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Failed to fetch your orders" });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const doc = await db.collection("orders").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Order not found" });

    const orderData = doc.data();

    // IDOR protection:
    //  - admin / staff: any order
    //  - customer: only their own order
    const role = req.user?.role?.toLowerCase();
    const isAuthorized =
      ['admin', 'staff'].includes(role) ||
      orderData.userId === req.user.uid;

    if (!isAuthorized) {
      return res.status(403).json({ success: false, error: "Forbidden: You do not have access to this order" });
    }

    if (await reconcileRazorpayOrder(doc.id, orderData)) {
      const fresh = await db.collection("orders").doc(doc.id).get();
      return res.status(200).json({ success: true, data: orderForViewer({ id: doc.id, ...fresh.data() }, req.user) });
    }
    return res.status(200).json({ success: true, data: orderForViewer({ id: doc.id, ...orderData }, req.user) });
  } catch (err) {
    log.error("order.get_by_id_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const RAZORPAY_RESERVATION_MINUTES = 10;
const GST_RATE_OK = (r) => r !== null && r !== '' && r !== undefined && [0, 5, 12, 18, 28].includes(Number(r));

// Only these customerInfo sub-fields are accepted from the client; email is
// always taken from the authenticated session.
function sanitizeCustomerInfo(ci = {}, sessionEmail) {
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const firstName = s(ci.firstName, 80);
  const lastName = s(ci.lastName, 80);
  const out = {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim(),
    email: sessionEmail || null,
    phone: s(ci.phone, 20),
    address: s(ci.address, 300),
    city: s(ci.city, 120),
    state: s(ci.state, 120),
    // Indian PIN: digits only, max 6. Kept lenient (not rejected here) so old
    // free-text addresses don't break; delivery resolution validates strictly.
    pincode: s(ci.pincode, 12).replace(/\D/g, '').slice(0, 6),
    // Razorpay is the only supported payment method — never trust the client here.
    paymentMethod: 'razorpay',
  };
  if (ci.coords && typeof ci.coords === 'object' && Number.isFinite(Number(ci.coords.lat)) && Number.isFinite(Number(ci.coords.lng))) {
    out.coords = { lat: Number(ci.coords.lat), lng: Number(ci.coords.lng) };
  }
  return out;
}

/** Short public URL for a product's main photo (never the inline base64 data). */
function orderItemImageUrl(req, productId, product) {
  // Lazy require: productController requires this module's dependencies (load cycle).
  const { publicImageUrl } = require('./productController');
  const host = typeof req.get === 'function' ? req.get('host') : null;
  const base = (process.env.API_PUBLIC_URL || (host ? `${req.protocol || 'https'}://${host}` : '')).replace(/\/+$/, '');
  const url = publicImageUrl(base, productId, product, 'main');
  return typeof url === 'string' && !url.startsWith('data:') ? url : '';
}

exports.createOrder = async (req, res) => {
  try {
    const { items, couponCode } = req.body;
    const uid = req.user.uid;
    const customerInfo = sanitizeCustomerInfo(req.body.customerInfo, req.user.email);

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Cart is empty" });
    }
    if (!customerInfo.firstName || !customerInfo.address || !customerInfo.city || !customerInfo.state) {
      return res.status(400).json({ success: false, code: 'ADDRESS_INCOMPLETE', error: "Please fill in your name, address, city and state." });
    }
    // The courier needs a reachable Indian mobile and a valid PIN — without them a
    // paid order could never be shipped.
    const mobile = String(customerInfo.phone || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({ success: false, code: 'PHONE_INVALID', error: "Please enter a valid 10-digit mobile number so the courier can reach you." });
    }
    customerInfo.phone = mobile;
    if (!isValidPincode(customerInfo.pincode)) {
      return res.status(400).json({ success: false, code: 'PINCODE_INVALID', error: "Please enter a valid 6-digit PIN code." });
    }

    const idempotencyKey = req.headers['idempotency-key'] || null;

    // ── 1. Authoritative subtotal + server-built item list (pre-txn) ──
    // Every stored item field comes from the product doc, never the client, so a
    // manipulated cart cannot poison order records or analytics.
    let calculatedSubtotal = 0;
    const uniqueProductIds = [...new Set(items.map(i => i.productId).filter(Boolean))];
    if (uniqueProductIds.length === 0) {
      return res.status(400).json({ success: false, error: "Cart has no valid products" });
    }
    const productDocs = await db.getAll(...uniqueProductIds.map((id) => db.collection("products").doc(id)));
    const productMap = new Map();
    productDocs.forEach((d) => { if (d.exists) productMap.set(d.id, d.data()); });

    const sanitizedItems = [];
    for (const item of items) {
      const qty = Number(item.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
        return res.status(400).json({ success: false, error: `Invalid quantity for ${item.name || item.productId}` });
      }
      const product = productMap.get(item.productId);
      if (!product) {
        return res.status(400).json({ success: false, error: `Product not found: ${item.productId}` });
      }
      if (product.status === 'inactive' || product.active === false || product.isDraft === true || product.isPrivate === true) {
        return res.status(400).json({ success: false, error: `${product.name || product.title} is not available` });
      }
      const variants = product.variants || [];
      let vi = variants.findIndex(v => v.weight === item.selectedWeight);
      if (vi === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight) && variants.length > 0) vi = 0;
      if (vi === -1) {
        return res.status(400).json({ success: false, error: `Variant "${item.selectedWeight || 'Default'}" not found for ${product.name || product.title}` });
      }
      const unitPrice = Number(variants[vi]?.price ?? product.price ?? 0);
      calculatedSubtotal += unitPrice * qty;
      sanitizedItems.push({
        productId: item.productId,
        selectedWeight: variants[vi]?.weight || item.selectedWeight || 'Standard',
        quantity: qty,
        name: product.name || product.title || 'Product',
        price: unitPrice,
        // Product photos are stored inline as base64 (50–200 KB each). Copying them
        // into every line pushed multi-product carts past Firestore's 1 MB document
        // limit, so orders/reservations keep the short cacheable image URL instead.
        image: orderItemImageUrl(req, item.productId, product),
        category: product.category || 'General',
        // Packed weight / size snapshot so the parcel matches what was sold.
        ...variantShipping(variants[vi]),
        ...(product.requiresBox === true ? { requiresBox: true } : {}),
        // Catalogue SKU + tax data for the Shiprocket order / invoice.
        ...(variants[vi]?.sku ? { sku: String(variants[vi].sku) } : {}),
        ...(product.hsn ? { hsn: String(product.hsn) } : {}),
        ...(GST_RATE_OK(product.gstRate) ? { gstRate: Number(product.gstRate) } : {}),
      });
    }

    // ── 1b. Authoritative delivery fee (server-side; the client fee is never trusted) ──
    // deliveryMethod comes from the client's choice; the FEE is resolved here from
    // the `deliveryPincodes` / `deliverySettings` config. A missing or malformed
    // PIN falls back to the global default (backward-compatible with old clients);
    // an explicitly unavailable PIN is rejected.
    const deliveryMethod = DELIVERY_METHODS.includes(req.body.deliveryMethod) ? req.body.deliveryMethod : 'standard';
    const resolvePincode = isValidPincode(customerInfo.pincode) ? customerInfo.pincode : '';
    let delivery;
    // The package this cart auto-packs into — quoted now, reused at dispatch.
    // For courier PINs, packaging options are ranked by the real freight for
    // their chargeable weight (cached quotes), not just by size.
    const packagingSettings = await getPackagingSettings();
    const partner = resolvePincode ? partnerOf(await getPincodeRule(resolvePincode)) : 'shiprocket';
    const rateLookup = resolvePincode && partner === 'shiprocket'
      ? (kg) => courierRateFor(resolvePincode, kg, deliveryMethod)
      : undefined;
    const plannedPkg = await quotePackage(sanitizedItems, { rateLookup });
    try {
      delivery = await computeDeliveryFee({
        pincode: resolvePincode,
        method: deliveryMethod,
        subtotal: calculatedSubtotal,
        // Real parcel weight → correct courier check, ETA and freight quote.
        weightKg: plannedPkg?.chargeableKg ?? null,
      });
    } catch (delErr) {
      if (delErr instanceof DeliveryError) {
        return res.status(400).json({ success: false, error: delErr.publicMessage, code: delErr.code });
      }
      throw delErr;
    }
    // Shiprocket ships one parcel: a cart bigger than the largest box can't be quoted or shipped.
    if (plannedPkg?.oversize && delivery.partner !== 'local') {
      return res.status(400).json({ success: false, error: OVERSIZE_MESSAGE, code: 'PARCEL_TOO_LARGE' });
    }
    const shipping = delivery.fee;

    // ── 2. Resolve the coupon by code (existence/active/expiry/min gate here;
    //       the authoritative consume + per-user + usage-limit check is in the txn) ──
    // A coupon the customer saw applied but that no longer qualifies must NOT be
    // dropped silently (Razorpay would then charge more than the checkout showed).
    let couponRef = null;
    if (couponCode && typeof couponCode === 'string' && couponCode.trim()) {
      const snap = await db.collection("coupons").where("code", "==", couponCode.toUpperCase().trim()).limit(1).get();
      const c = snap.empty ? null : snap.docs[0].data();
      const isExpired = c && c.expiresAt && new Date(c.expiresAt.toDate ? c.expiresAt.toDate() : c.expiresAt) < new Date();
      if (!c || !c.isActive || isExpired) {
        return res.status(400).json({ success: false, code: 'COUPON_INVALID', error: "This coupon is no longer valid. Remove it to continue." });
      }
      if (calculatedSubtotal < (c.minOrderValue || 0)) {
        return res.status(400).json({ success: false, code: 'COUPON_MIN_ORDER', error: `This coupon needs a minimum order of ₹${c.minOrderValue}. Add more items or remove the coupon.` });
      }
      couponRef = snap.docs[0].ref;
    }

    // ── 3. Transaction: stock, coupon (COD only), order/reservation ──
    const txResult = await runStockTxn(async (t) => {
      // reads
      const idempRef = idempotencyKey ? db.collection('idempotencyKeys').doc(idempotencyKey) : null;
      if (idempRef) {
        const existing = await t.get(idempRef);
        if (existing.exists) throw new Error("DUPLICATE_CHECKOUT");
      }

      // Read each product ONCE and keep working on that copy, so two lines of the
      // same product (different sizes, or a duplicated line) are both deducted —
      // re-reading would hand back the original stock and lose the first deduction.
      const productUpdates = new Map();
      for (const item of sanitizedItems) {
        let entry = productUpdates.get(item.productId);
        if (!entry) {
          const productRef = db.collection("products").doc(item.productId);
          const productDoc = await t.get(productRef);
          if (!productDoc.exists) throw new Error(`Product ${item.productId} not found`);
          entry = { ref: productRef, variants: (productDoc.data().variants || []).map((v) => ({ ...v })), quantityChange: 0 };
          productUpdates.set(item.productId, entry);
        }
        const { variants } = entry;
        let vi = variants.findIndex(v => v.weight === item.selectedWeight);
        if (vi === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight) && variants.length > 0) vi = 0;
        if (vi === -1) throw new Error(`Variant "${item.selectedWeight || 'Default'}" not found for ${item.name}`);
        const qty = Number(item.quantity);
        const left = Math.max(0, Number(variants[vi].stock) || 0);
        if (left < qty) {
          throw Object.assign(new Error('OUT_OF_STOCK'), {
            publicMessage: left > 0
              ? `Only ${left} left of ${item.name} (${variants[vi].weight}). Please reduce the quantity.`
              : `${item.name} (${variants[vi].weight}) just sold out. Please remove it from your cart.`,
          });
        }
        variants[vi].stock = left - qty;
        entry.quantityChange += qty;
      }

      // Consume the coupon inside the transaction so concurrent checkouts can't
      // over-redeem. The redemption is marked `pending` and released if the
      // payment never completes.
      let discountAmount = 0;
      let couponId = null;
      let couponCode2 = null;
      if (couponRef) {
        const consumed = await consumeCouponInTxn(t, {
          couponRef, uid, subtotal: calculatedSubtotal, pending: true,
        });
        discountAmount = consumed.discountAmount;
        couponId = consumed.couponId;
        couponCode2 = consumed.couponCode;
      }

      const totalAmount = Math.max(0, calculatedSubtotal + shipping - discountAmount);

      // writes
      for (const [, u] of productUpdates) {
        t.update(u.ref, {
          variants: u.variants,
          stock: admin.firestore.FieldValue.increment(-u.quantityChange),
        });
      }

      const baseOrder = {
        items: sanitizedItems,
        subtotal: calculatedSubtotal,
        shipping, // === deliveryFee — kept for backward compatibility
        deliveryFee: delivery.fee,
        deliveryMethod: delivery.method,
        deliveryPincode: resolvePincode || customerInfo.pincode || null,
        deliveryEstimate: delivery.eta || null,
        // Who delivers ('local' = dedicated partner, never pushed to Shiprocket)
        // and Shiprocket's freight quote at checkout (for fee-vs-cost margin).
        deliveryPartner: delivery.partner || 'shiprocket',
        estimatedShippingCost: delivery.estimatedShippingCost ?? null,
        // Cheapest (or express, for fastest) courier quoted at checkout + the box it
        // was quoted for. Dispatch reuses both so the cost matches what was charged.
        quotedCourier: delivery.quotedCourier || null,
        plannedPackage: packageSnapshot(plannedPkg),
        // Structured estimate-vs-actual record (models/orderShipping.js).
        logistics: buildInitialShipping({
          pkg: plannedPkg,
          quote: delivery.quote,
          fee: delivery.fee,
          requireVerification: packagingSettings.requirePackingVerification,
          partner: delivery.partner || 'shiprocket',
        }),
        totalAmount,
        discountAmount,
        couponId,
        couponCode: couponCode2,
        customerInfo,
        userId: uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Claim the idempotency key inside the transaction (t.create throws on a
      // concurrent duplicate) so parallel identical submits can't both proceed.
      if (idempRef) {
        t.create(idempRef, {
          status: 'PENDING',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
      }

      const reservationRef = db.collection("stockReservations").doc();
      t.set(reservationRef, {
        items: sanitizedItems,
        status: "ACTIVE",
        userId: uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + RAZORPAY_RESERVATION_MINUTES * 60000),
      });
      return { reservationId: reservationRef.id, baseOrder, totalAmount, discountAmount, couponId, couponCode: couponCode2, idempRef };
    });

    // ── 4. Create the Razorpay gateway order + persist ──
    const { reservationId, totalAmount } = txResult;
    try {
      // Reserve our order ID first and stamp it on the Razorpay order (notes +
      // receipt), so a webhook or an admin can always match a payment back to
      // this order — even when the razorpayOrderId lookup misses.
      const newOrderRef = db.collection("orders").doc();
      const rzpOrder = await razorpay.orders.create({
        amount: Math.round(totalAmount * 100),
        currency: "INR",
        receipt: `rcpt_${newOrderRef.id}`.slice(0, 40),
        notes: { orderId: newOrderRef.id },
      });

      const orderData = {
        ...txResult.baseOrder,
        status: "payment_pending",
        razorpayOrderId: rzpOrder.id,
        reservationId,
      };
      await newOrderRef.set(orderData);
      await db.collection("stockReservations").doc(reservationId).update({
        orderId: newOrderRef.id,
        razorpayOrderId: rzpOrder.id,
      });
      if (txResult.idempRef) {
        await txResult.idempRef.set({
          orderId: newOrderRef.id,
          reservationId,
          razorpayOrderId: rzpOrder.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
      }

      return res.status(201).json({
        success: true,
        isRazorpay: true,
        razorpayOrderId: rzpOrder.id,
        amount: rzpOrder.amount,
        key_id: process.env.RAZORPAY_KEY_ID,
        orderId: newOrderRef.id,
      });
    } catch (rzpErr) {
      await releaseReservation(reservationId, 'RELEASED');
      await releaseCoupon(txResult.couponId, uid); // free the provisional redemption
      log.error('order.razorpay_init_failed', { requestId: req.id, err: rzpErr });
      return res.status(502).json({ success: false, code: 'PAYMENT_GATEWAY_DOWN', error: "Our payment partner isn't responding right now. You have not been charged — please try again in a minute." });
    }
  } catch (err) {
    const ref = String(req.id || '').slice(0, 8).toUpperCase();
    const fail = (status, code, error) => res.status(status).json({ success: false, code, error, ...(ref ? { ref } : {}) });
    const map = {
      DUPLICATE_CHECKOUT: [409, "This order is already being placed — please wait a moment."],
      COUPON_INVALID: [400, "This coupon can't be used on this order. Remove it to continue."],
      COUPON_LIMIT: [400, "This coupon has reached its usage limit. Remove it to continue."],
      COUPON_ALREADY_USED: [400, "You've already used this coupon. Remove it to continue."],
    };
    if (map[err.message]) {
      const [status, message] = map[err.message];
      return fail(status, err.message, message);
    }
    if (err.message === 'OUT_OF_STOCK') return fail(409, 'OUT_OF_STOCK', err.publicMessage);
    // t.create() on an existing idempotency key (concurrent duplicate)
    if (err.code === 6 || /ALREADY_EXISTS/i.test(err.message || '')) {
      return fail(409, 'DUPLICATE_CHECKOUT', "This order is already being placed — please wait a moment.");
    }
    if (/^(Product .* not found|Variant .* not found)/.test(err.message || '')) {
      return fail(409, 'CART_CHANGED', "An item in your cart changed or is no longer available. Please review your cart and try again.");
    }
    log.error("order.create_failed", { requestId: req.id, err });
    // Firestore busy / temporarily unreachable (ABORTED, DEADLINE_EXCEEDED, UNAVAILABLE, RESOURCE_EXHAUSTED).
    if ([4, 8, 10, 14].includes(err.code)) {
      return fail(503, 'TEMPORARILY_BUSY', "We're a little busy right now. Please try again in a few seconds — you have not been charged.");
    }
    // Outside production, surface the real cause so it shows in the checkout toast.
    const detail = process.env.NODE_ENV !== 'production' && err?.message ? ` (${err.message})` : '';
    return fail(500, 'ORDER_FAILED', `We couldn't place your order. You have not been charged — please try again, or contact us with reference ${ref || 'N/A'}.${detail}`);
  }
};

exports.verifyRazorpay = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, orderId } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !orderId) {
      return res.status(400).json({ success: false, error: "Missing payment fields" });
    }

    const digest = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    const a = Buffer.from(digest);
    const b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({ success: false, error: "Invalid payment signature" });
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists) return res.status(404).json({ success: false, error: "Order not found" });

    const orderData = orderDoc.data();

    // Owner (or staff) only
    if (orderData.userId !== req.user.uid && !['admin', 'staff'].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    // The signature only proves Razorpay issued THIS razorpay_order_id. It must be
    // the one created for this order — otherwise a payment for a cheap order could
    // be replayed to confirm an expensive one.
    if (!orderData.razorpayOrderId || orderData.razorpayOrderId !== String(razorpay_order_id)) {
      log.warn('order.verify_order_mismatch', { requestId: req.id, orderId });
      return res.status(400).json({ success: false, error: "Payment does not belong to this order" });
    }
    if (orderData.status !== "payment_pending" && !isRevivableCancelledOrder(orderData)) {
      if (orderData.razorpayPaymentId) {
        return res.status(200).json({ success: true, status: orderData.status, message: "Order already confirmed" });
      }
      // Cancelled for another reason (never silently claim success for an unpaid order).
      log.warn('order.verify_unexpected_state', { requestId: req.id, orderId, status: orderData.status });
      return res.status(409).json({
        success: false,
        code: 'ORDER_NOT_PAYABLE',
        error: "This order can no longer be paid. If money was deducted, it will be refunded automatically — or contact us with your payment ID.",
      });
    }

    await confirmRazorpayPayment(orderId, razorpay_payment_id, 'verify');
    const fresh = (await orderRef.get()).data() || {};

    return res.status(200).json({
      success: true,
      status: fresh.status,
      message: fresh.status === 'payment_successful_no_stock'
        ? "Payment received. An item sold out moments ago — our team will contact you to arrange it or refund you."
        : "Payment verified and order confirmed",
    });
  } catch (error) {
    log.error("order.verify_razorpay_failed", { requestId: req.id, err: error });
    const orderId = req.body?.orderId;
    if (orderId) {
      const oDoc = await db.collection("orders").doc(String(orderId)).get().catch(() => null);
      if (oDoc?.exists && await reconcileRazorpayOrder(oDoc.id, oDoc.data())) {
        return res.status(200).json({ success: true, message: "Payment confirmed" });
      }
    }
    return res.status(500).json({ success: false, error: "Payment verification failed" });
  }
};

/**
 * Condense a Razorpay payment entity into a small, display-friendly summary
 * ({ method: 'upi' | 'card' | ..., detail: 'HDFC ••4242' }) stored on the order
 * so admin/customer screens can show "UPI", "Card", etc. instead of just
 * "Online".
 */
function summarizePayment(p) {
  if (!p || !p.method) return null;
  const out = { method: p.method };
  if (p.method === 'card' && p.card) {
    out.detail = [p.card.network || 'Card', p.card.last4 ? `••${p.card.last4}` : ''].join(' ').trim();
  } else if (p.method === 'upi') {
    out.detail = p.vpa || p.upi?.vpa || 'UPI';
  } else if (p.method === 'netbanking') {
    out.detail = p.bank || 'Netbanking';
  } else if (p.method === 'wallet') {
    out.detail = p.wallet || 'Wallet';
  }
  return out;
}

/**
 * Shared, idempotent confirmation of a paid Razorpay order. Runs in a
 * transaction guarded by status === 'payment_pending', so the verify call and
 * the webhook race safely — only one wins.
 */
/**
 * A payment that is only `authorized` is NOT money in the bank: with auto-capture
 * off (or a late authorisation) Razorpay refunds it to the customer after a few
 * days unless we capture it. Capture it now; returns the (possibly updated)
 * payment entity. Never throws.
 */
async function ensureCaptured(payment, orderId) {
  if (!payment || payment.status !== 'authorized') return payment;
  try {
    return await razorpay.payments.capture(payment.id, payment.amount, payment.currency || 'INR');
  } catch (err) {
    // Often a harmless race with Razorpay's own auto-capture — re-check.
    const fresh = await razorpay.payments.fetch(payment.id).catch(() => null);
    if (fresh && fresh.status === 'captured') return fresh;
    log.error('order.payment_capture_failed', { orderId, paymentId: payment.id, err });
    createNotification('admin', 'Capture payment in Razorpay',
      `Payment ${payment.id} for order #${String(orderId).slice(-6).toUpperCase()} is authorized but could not be captured. Capture it in the Razorpay dashboard or it will be auto-refunded.`,
      { orderId });
    return fresh || payment;
  }
}

async function confirmRazorpayPayment(orderId, paymentId, source) {
  // Fetch the instrument used (UPI / card / netbanking / wallet) for display,
  // and capture the payment if it is only authorized.
  let paymentDetails = null;
  try {
    const payment = await ensureCaptured(await razorpay.payments.fetch(paymentId), orderId);
    paymentDetails = summarizePayment(payment);
  } catch (e) {
    log.warn('order.payment_fetch_failed', { orderId, err: e });
  }
  return markOrderPaid(orderId, { paymentId, paymentDetails, source });
}

/**
 * Shared, idempotent "this order is now paid" transition — used for Razorpay
 * payments (verify / webhook / reconcile / admin sync) and for payments an admin
 * records manually. Takes stock back if the reservation had lapsed, finalises
 * the coupon, bumps analytics, then notifies customer + team.
 * Returns true when THIS call confirmed the order.
 */
async function markOrderPaid(orderId, { paymentId = null, paymentDetails = null, manualPayment = null, source }) {
  const orderRef = db.collection("orders").doc(orderId);
  let confirmedData = null;
  let revived = false;
  await runStockTxn(async (t) => {
    // ── ALL READS FIRST (Firestore throws on a read after a write) ──
    const oDoc = await t.get(orderRef);
    if (!oDoc.exists) return;
    const oData = oDoc.data();
    const isPending = oData.status === "payment_pending";
    const isLate = isRevivableCancelledOrder(oData);
    if (!isPending && !isLate) return; // already confirmed / refunded / etc.

    let resRef = null;
    let resStatus = null;
    if (oData.reservationId) {
      resRef = db.collection("stockReservations").doc(oData.reservationId);
      const resDoc = await t.get(resRef);
      resStatus = resDoc.exists ? resDoc.data().status : null;
      if (!resDoc.exists) resRef = null;
    }
    // Stock was returned (expired/abandoned reservation) → try to take it again.
    const needsRestock = isLate || (resStatus && resStatus !== 'ACTIVE' && resStatus !== 'CONFIRMED');
    const restock = needsRestock ? await readRestock(t, oData.items) : null;
    const coupon = await readCouponConfirm(t, oData);

    // ── WRITES ──
    let newOrderStatus = "pending";
    if (needsRestock) {
      if (restock.available) applyRestockTake(t, restock);
      else newOrderStatus = "payment_successful_no_stock"; // paid, but sold out meanwhile → team arranges stock or refunds
    }
    if (resRef && (resStatus === 'ACTIVE' || (needsRestock && restock.available))) {
      t.update(resRef, { status: 'CONFIRMED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    applyCouponConfirm(t, coupon);

    t.update(orderRef, {
      status: newOrderStatus,
      ...(paymentId ? { razorpayPaymentId: paymentId } : {}),
      ...(paymentDetails ? { paymentDetails } : {}),
      ...(manualPayment ? { manualPayment } : {}),
      paymentConfirmedBy: source,
      ...(isLate ? { cancelReason: admin.firestore.FieldValue.delete(), revivedFromCancel: true } : {}),
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    incrementSalesAnalytics(t, oData, 'razorpay');
    confirmedData = { ...oData, status: newOrderStatus };
    revived = isLate;
  });

  if (!confirmedData) {
    // Normal when verify + webhook race (same payment already recorded). Anything
    // else is money captured for an order we can't fulfil (or already paid by
    // another payment / a manual entry) → the team must refund the extra one.
    const cur = (await orderRef.get().catch(() => null))?.data();
    if (paymentId && cur && cur.razorpayPaymentId !== paymentId) {
      log.error('order.payment_captured_unmatched', { orderId, paymentId, status: cur.status });
      createNotification('admin', 'Payment needs attention',
        `Payment ${paymentId} was captured for order #${orderId.slice(-6).toUpperCase()} (status: ${cur.status}${cur.manualPayment ? ', already marked paid manually' : ''}). Refund it from Razorpay if it is a duplicate or the order won't be fulfilled.`,
        { orderId });
    }
    return false;
  }
  if (revived) log.warn('order.late_payment_revived', { orderId, paymentId, status: confirmedData.status });

  // Push in-stock paid orders to Shiprocket (no-op when Shiprocket isn't configured).
  if (confirmedData.status === 'pending') autoCreateShipment(orderId);

  const short = `#${orderId.slice(-6).toUpperCase()}`;
  sendOrderEmail(orderId, 'paid');
  alertTeamOfPaidOrder(orderId);
  // The team is emailed the full order by alertTeamOfPaidOrder above.
  log.info('order.payment_confirmed', { orderId, source });
  return true;
}

/** True for an order whose payment has not been confirmed yet (and could still be). */
const isAwaitingPayment = (o) => !!o && (o.status === 'payment_pending' || isRevivableCancelledOrder(o));

const tsMillis = (v) => {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
};

/**
 * Ask Razorpay whether an unpaid order was actually paid, and confirm it if so.
 * Covers a lost browser verify call and a missed / misconfigured webhook —
 * without it a paid order stays "pending" on the dashboard or gets cancelled by
 * the reservation cleanup. An `authorized` payment counts (it is captured here).
 *
 * `includeCancelled`: also check orders the system auto-cancelled when the
 * payment window lapsed (slow UPI that completed after the customer closed the
 * Razorpay window). Off by default on hot read paths to avoid a Razorpay call
 * for every old cancelled order.
 * Returns true when the order is (now) paid.
 */
async function reconcileRazorpayOrder(orderId, oData, { includeCancelled = false } = {}) {
  if (!oData || !oData.razorpayOrderId) return false;
  const eligible = oData.status === 'payment_pending' || (includeCancelled && isRevivableCancelledOrder(oData));
  if (!eligible) return false;
  try {
    const { items = [] } = await razorpay.orders.fetchPayments(oData.razorpayOrderId);
    const paid = items.find((p) => p.status === 'captured') || items.find((p) => p.status === 'authorized');
    if (!paid) return false;
    await confirmRazorpayPayment(orderId, paid.id, 'reconcile');
    const now = (await db.collection('orders').doc(orderId).get()).data();
    return !!now && !isAwaitingPayment(now);
  } catch (err) {
    log.warn('order.razorpay_reconcile_failed', { orderId, err });
    return false;
  }
}

// Recently auto-cancelled orders are re-checked too (a late UPI payment can land
// hours after the window closed).
const RECHECK_CANCELLED_MS = 3 * 24 * 60 * 60 * 1000;
const recentlyCancelledUnpaid = (o) => isRevivableCancelledOrder(o)
  && Date.now() - tsMillis(o.updatedAt || o.createdAt) < RECHECK_CANCELLED_MS;

/** Run `fn` over `items` with at most `n` in flight (keeps Razorpay calls polite). */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Reconcile a refund that originated in the Razorpay dashboard (not our API).
 * Idempotent — no-ops if the order is already `refunded`. Same reversal as
 * refundOrder: restock + coupon release + analytics decrement.
 */
async function reconcileDashboardRefund(entity) {
  const paymentId = entity.payment_id;
  const refundId = entity.id;
  const amountRupees = (Number(entity.amount) || 0) / 100;
  if (!paymentId) return;

  const snap = await db.collection("orders").where("razorpayPaymentId", "==", paymentId).limit(1).get();
  if (snap.empty) {
    log.warn('webhook.refund_no_order', { paymentId, refundId });
    return;
  }
  const orderRef = snap.docs[0].ref;

  let reconciled = false;
  await runStockTxn(async (t) => {
    const oDoc = await t.get(orderRef);
    if (!oDoc.exists) return;
    const oData = oDoc.data();
    if (oData.status === 'refunded') return;                // already handled (e.g. by our API)
    if (!REFUNDABLE_STATES.includes(oData.status)) return;  // not a state we reverse

    const rev = await readOrderReversal(t, oData);
    t.update(orderRef, {
      status: 'refunded',
      refundId: refundId || null,
      refundAmount: amountRupees || Number(oData.totalAmount) || 0,
      refundStatus: entity.status || 'processed',
      refundSource: 'razorpay_dashboard',
      refundedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    applyOrderReversal(t, oData, rev);
    decrementSalesAnalytics(t, oData, 'razorpay');
    reconciled = true;
  });

  if (!reconciled) return;
  log.info('webhook.refund_reconciled', { orderId: orderRef.id, refundId });
  const short = `#${orderRef.id.slice(-6).toUpperCase()}`;
  const fresh = (await orderRef.get()).data();
  sendOrderEmail(orderRef.id, 'refunded', { refundAmount: amountRupees || Number(fresh?.totalAmount) || 0 });
  createNotification('admin', 'Refund Processed', `Refund for order ${short} was processed (Razorpay webhook).`, { orderId: orderRef.id });
}

/**
 * Our order for a Razorpay order: by stored razorpayOrderId, else by the order ID
 * we stamp into the Razorpay order's notes (only trusted when the stored
 * razorpayOrderId agrees, or the order has none recorded).
 */
async function findOrderIdForRazorpay(razorpayOrderId, notedOrderId) {
  if (razorpayOrderId) {
    const snap = await db.collection("orders").where("razorpayOrderId", "==", razorpayOrderId).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
  }
  if (notedOrderId && typeof notedOrderId === 'string') {
    const doc = await db.collection("orders").doc(notedOrderId).get();
    if (doc.exists) {
      const stored = doc.data().razorpayOrderId;
      if (!stored || stored === razorpayOrderId) return doc.id;
    }
  }
  return null;
}

exports.razorpayWebhook = async (req, res) => {
  let eventRef = null;
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) return res.status(400).send('Missing signature');

    // req.body is a raw Buffer (express.raw mounted for this path in index.js)
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const sigBuf = Buffer.from(signature);
    const digBuf = Buffer.from(digest);
    if (sigBuf.length !== digBuf.length || !crypto.timingSafeEqual(sigBuf, digBuf)) {
      log.warn('webhook.bad_signature', { requestId: req.id });
      return res.status(400).send('Invalid signature');
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).send('Malformed payload');
    }

    // Event de-duplication
    const eventId = req.headers['x-razorpay-event-id'] || payload.id || `${payload.event}:${Date.now()}`;
    eventRef = db.collection('webhookEvents').doc(String(eventId));
    const seen = await eventRef.get();
    if (seen.exists) return res.status(200).send('Duplicate event ignored');
    await eventRef.set({
      event: payload.event,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    log.info('webhook.received', { requestId: req.id, event: payload.event, eventId });

    // Any of these means the customer paid. Subscribing to only one of them in the
    // Razorpay dashboard used to leave paid orders stuck as "pending":
    //  - payment.captured — normal auto-capture
    //  - order.paid       — fired once the Razorpay order is fully paid
    //  - payment.authorized — auto-capture OFF: we must capture it ourselves,
    //    otherwise Razorpay refunds the customer after a few days.
    if (['payment.captured', 'order.paid', 'payment.authorized'].includes(payload.event)) {
      const entity = payload.payload?.payment?.entity || {};
      const orderEntity = payload.payload?.order?.entity || {};
      const razorpayOrderId = entity.order_id || orderEntity.id;
      const paymentId = entity.id;
      const orderId = paymentId ? await findOrderIdForRazorpay(razorpayOrderId, entity.notes?.orderId || orderEntity.notes?.orderId) : null;
      if (orderId) {
        await confirmRazorpayPayment(orderId, paymentId, `webhook:${payload.event}`);
      } else if (paymentId) {
        log.warn('webhook.payment_no_order', { razorpayOrderId, paymentId, event: payload.event });
      }
    } else if (payload.event === 'refund.processed' || payload.event === 'refund.created') {
      // Dashboard-initiated refunds — reconcile them back to the order.
      await reconcileDashboardRefund(payload.payload?.refund?.entity || {});
    }

    return res.status(200).send('Webhook processed');
  } catch (error) {
    log.error("webhook.error", { requestId: req.id, err: error });
    // Un-mark the event so Razorpay's retry is processed instead of skipped as a duplicate.
    if (eventRef) await eventRef.delete().catch(() => {});
    return res.status(500).send('Internal server error');
  }
};

/**
 * PUT /orders/:id/status  (staff) — FULFILMENT transitions only.
 * Cancellation and refunds are handled by dedicated routes.
 */
exports.updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, proofImage } = req.body;
    const role = req.user?.role; // already lowercased by verifyToken

    if (!status) return res.status(400).json({ success: false, error: "Status is required" });
    if (status === 'cancelled' || status === 'refunded') {
      return res.status(400).json({
        success: false,
        error: "Use the cancel or refund action for this change",
      });
    }

    const docRef = db.collection("orders").doc(id);
    let existingData;

    await runStockTxn(async (t) => {
      const oDoc = await t.get(docRef);
      if (!oDoc.exists) throw new Error("NOT_FOUND");
      const oData = oDoc.data();
      existingData = oData;
      const currentStatus = oData.status;

      // Idempotent no-op
      if (currentStatus === status) {
        t.update(docRef, { updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        return;
      }

      const allowed = ORDER_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(status)) {
        throw new Error(`INVALID_TRANSITION: Cannot move an order from ${currentStatus} to ${status}`);
      }

      const updateData = { status, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
      if (proofImage && typeof proofImage === 'string' && proofImage.length < 2_000_000) {
        updateData.proofOfDelivery = proofImage;
      }
      t.update(docRef, updateData);
    });

    if (req.user && ['admin', 'staff'].includes(role)) {
      createAuditLog({
        adminId: req.user.uid,
        adminEmail: req.user.email || 'unknown',
        action: 'UPDATE_ORDER_STATUS',
        resourceId: id,
        previousState: { status: existingData.status },
        newState: { status },
        ipAddress: req.ip,
      });
    }

    sendOrderEmail(id, 'status', { status });
    createNotification('admin', 'Order Status Updated', `Order #${id.slice(-6).toUpperCase()} is now ${status.replace(/_/g, ' ')}`, { orderId: id });

    return res.status(200).json({ success: true, message: "Order status updated" });
  } catch (err) {
    if (err.message?.startsWith("FORBIDDEN")) return res.status(403).json({ success: false, error: err.message });
    if (err.message?.startsWith("INVALID_TRANSITION")) return res.status(400).json({ success: false, error: err.message });
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Order not found" });
    log.error('order.update_status_failed', { requestId: req.id, orderId: req.params.id, err });
    return res.status(500).json({ success: false, error: "Update failed" });
  }
};

// PUT /orders/:id/abandon-payment  (customer, own order) — NOT an order-cancellation
// feature: this only ever touches an order that never got paid (still
// `payment_pending`), releasing the stock reservation immediately instead of
// leaving it locked until the reservation's own expiry + cleanup cron catch up.
// A confirmed/placed order cannot be reached through this path.
exports.abandonPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection("orders").doc(id);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "Order not found" });
    const order = snap.data();
    if (order.userId !== req.user.uid) return res.status(403).json({ success: false, error: "Access denied" });
    if (order.status !== 'payment_pending') {
      return res.status(400).json({ success: false, error: "Order is not an unpaid pending payment" });
    }
    if (await reconcileRazorpayOrder(id, order)) {
      return res.status(200).json({ success: true, paid: true, message: "Payment already received — order confirmed" });
    }
    if (order.reservationId) {
      await releaseReservation(order.reservationId, 'RELEASED');
    }
    return res.status(200).json({ success: true, message: "Payment attempt released" });
  } catch (err) {
    log.error('order.abandon_payment_failed', { requestId: req.id, orderId: req.params.id, err });
    return res.status(500).json({ success: false, error: "Failed to release payment attempt" });
  }
};

// ── Admin: resolve payments that Razorpay received but the dashboard missed ──

const notAwaitingError = (o) => (o.razorpayPaymentId || o.manualPayment
  ? 'This order is already marked as paid'
  : `This order can't be marked paid from status "${o.status}"`);

/**
 * POST /orders/:id/sync-payment  (admin).  Body: { paymentId? }
 *  - no paymentId: ask Razorpay for this order's payments and confirm it if one
 *    was captured/authorized.
 *  - paymentId (pay_…, copied from the Razorpay dashboard): fetch that payment
 *    from Razorpay and confirm the order with it after checking it is genuinely
 *    paid, is for this order (or an unlinked payment of at least the order
 *    total, e.g. a payment link / QR) and isn't already used by another order.
 */
exports.syncOrderPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const orderRef = db.collection('orders').doc(id);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Order not found' });
    const order = snap.data();
    if (!isAwaitingPayment(order)) {
      return res.status(409).json({ success: false, error: notAwaitingError(order) });
    }

    const paymentId = String(req.body?.paymentId || '').trim();
    if (!paymentId) {
      const paid = await reconcileRazorpayOrder(id, order, { includeCancelled: true });
      if (!paid) {
        return res.status(200).json({ success: true, paid: false, message: 'Razorpay has no successful payment for this order yet.' });
      }
    } else {
      if (!/^pay_[A-Za-z0-9]{6,30}$/.test(paymentId)) {
        return res.status(400).json({ success: false, error: 'Enter a Razorpay payment ID like pay_XXXXXXXXXXXXXX' });
      }
      let payment;
      try {
        payment = await razorpay.payments.fetch(paymentId);
      } catch (err) {
        const desc = err?.error?.description;
        return res.status(400).json({ success: false, error: desc ? `Razorpay: ${desc}` : 'Razorpay has no payment with that ID' });
      }
      if (!['captured', 'authorized'].includes(payment?.status)) {
        return res.status(400).json({ success: false, error: `That payment is "${payment?.status || 'unknown'}" in Razorpay, not paid` });
      }
      const expectedPaise = Math.round((Number(order.totalAmount) || 0) * 100);
      if (payment.order_id && payment.order_id !== order.razorpayOrderId) {
        return res.status(400).json({ success: false, error: `That payment belongs to a different Razorpay order (${payment.order_id})` });
      }
      if (!payment.order_id && Number(payment.amount) < expectedPaise) {
        return res.status(400).json({ success: false, error: `That payment is ₹${Number(payment.amount) / 100}, less than the order total ₹${expectedPaise / 100}` });
      }
      const used = await db.collection('orders').where('razorpayPaymentId', '==', paymentId).limit(1).get();
      if (!used.empty && used.docs[0].id !== id) {
        return res.status(409).json({ success: false, error: `That payment is already linked to order #${used.docs[0].id.slice(-6).toUpperCase()}` });
      }
      await confirmRazorpayPayment(id, paymentId, 'admin_sync');
    }

    const fresh = (await orderRef.get()).data() || {};
    if (isAwaitingPayment(fresh)) {
      return res.status(409).json({ success: false, error: 'Could not confirm the payment — please try again' });
    }
    createAuditLog({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: 'SYNC_ORDER_PAYMENT',
      resourceId: id,
      previousState: { status: order.status },
      newState: { status: fresh.status, razorpayPaymentId: fresh.razorpayPaymentId || null },
      ipAddress: req.ip,
    });
    return res.status(200).json({
      success: true,
      paid: true,
      message: fresh.status === 'payment_successful_no_stock'
        ? 'Payment confirmed — but an item is out of stock now. Arrange stock or refund the customer.'
        : 'Payment confirmed from Razorpay — order is now placed.',
      data: orderForViewer({ id, ...fresh }, req.user),
    });
  } catch (err) {
    log.error('order.sync_payment_failed', { requestId: req.id, orderId: req.params.id, err });
    return res.status(500).json({ success: false, error: 'Failed to check the payment with Razorpay' });
  }
};

const MANUAL_PAYMENT_METHODS = ['upi', 'bank_transfer', 'cash', 'razorpay_link', 'other'];

/**
 * POST /orders/:id/mark-paid  (admin) — record a payment received OUTSIDE this
 * order's Razorpay checkout (direct UPI / bank transfer / cash / a payment link).
 * Body: { method, reference, amount, note? }.
 * Razorpay is checked first: if it shows the order paid, that is used instead.
 */
exports.markOrderPaidManually = async (req, res) => {
  try {
    const { id } = req.params;
    const method = String(req.body?.method || '').trim();
    const reference = String(req.body?.reference || '').trim().slice(0, 100);
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const amount = Number(req.body?.amount);

    if (!MANUAL_PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({ success: false, error: 'Choose how the payment was received' });
    }
    if (method !== 'cash' && reference.length < 4) {
      return res.status(400).json({ success: false, error: 'Enter the transaction reference (UTR / UPI ref / payment ID)' });
    }
    if (method === 'cash' && !reference && note.length < 4) {
      return res.status(400).json({ success: false, error: 'Add a note (who collected the cash, when)' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, error: 'Enter the amount received' });
    }

    const orderRef = db.collection('orders').doc(id);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Order not found' });
    const order = snap.data();
    if (!isAwaitingPayment(order)) {
      return res.status(409).json({ success: false, error: notAwaitingError(order) });
    }
    const total = Number(order.totalAmount) || 0;
    if (amount + 0.005 < total) {
      return res.status(400).json({ success: false, error: `Amount received (₹${amount}) is less than the order total (₹${total})` });
    }

    // Never record a manual payment for an order Razorpay already got paid for —
    // that would hide a real gateway payment (and a possible double charge).
    if (await reconcileRazorpayOrder(id, order, { includeCancelled: true })) {
      const fresh = (await orderRef.get()).data() || {};
      return res.status(200).json({
        success: true,
        reconciled: true,
        message: 'Razorpay already shows this order as paid — confirmed with the Razorpay payment instead.',
        data: orderForViewer({ id, ...fresh }, req.user),
      });
    }

    if (reference) {
      const dup = await db.collection('orders').where('manualPayment.reference', '==', reference).limit(1).get();
      if (!dup.empty && dup.docs[0].id !== id) {
        return res.status(409).json({ success: false, error: `Reference ${reference} is already recorded on order #${dup.docs[0].id.slice(-6).toUpperCase()}` });
      }
    }

    const manualPayment = {
      method, reference: reference || null, amount, note: note || null,
      recordedBy: { uid: req.user.uid, email: req.user.email || null },
      recordedAt: new Date().toISOString(),
    };
    const confirmed = await markOrderPaid(id, {
      manualPayment,
      paymentDetails: { method, detail: reference ? `Manual · ${reference}` : 'Manual' },
      source: 'admin_manual',
    });
    if (!confirmed) {
      return res.status(409).json({ success: false, error: 'The order changed meanwhile — refresh and check again' });
    }

    const fresh = (await orderRef.get()).data() || {};
    createAuditLog({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: 'MARK_ORDER_PAID_MANUAL',
      resourceId: id,
      previousState: { status: order.status },
      newState: { status: fresh.status, method, reference: reference || null, amount },
      ipAddress: req.ip,
    });
    return res.status(200).json({
      success: true,
      message: fresh.status === 'payment_successful_no_stock'
        ? 'Payment recorded — but an item is out of stock now. Arrange stock or refund the customer.'
        : 'Payment recorded — order is now placed.',
      data: orderForViewer({ id, ...fresh }, req.user),
    });
  } catch (err) {
    log.error('order.mark_paid_failed', { requestId: req.id, orderId: req.params.id, err });
    return res.status(500).json({ success: false, error: 'Failed to record the payment' });
  }
};

/**
 * POST /orders/admin/sync-payments  (admin) — check every unpaid order (still
 * awaiting payment, or auto-cancelled in the last 3 days) against Razorpay and
 * confirm the ones that were actually paid.
 */
exports.syncPendingPayments = async (req, res) => {
  try {
    const [pendingSnap, cancelledSnap] = await Promise.all([
      db.collection('orders').where('status', '==', 'payment_pending').limit(200).get(),
      db.collection('orders').where('status', '==', 'cancelled').limit(500).get(),
    ]);
    const candidates = [
      ...pendingSnap.docs,
      ...cancelledSnap.docs.filter((d) => recentlyCancelledUnpaid(d.data())),
    ].filter((d) => d.data().razorpayOrderId);

    const results = await mapLimit(candidates, 4, async (d) => (
      (await reconcileRazorpayOrder(d.id, d.data(), { includeCancelled: true })) ? d.id : null
    ));
    const confirmed = results.filter(Boolean);
    if (confirmed.length) {
      createAuditLog({
        adminId: req.user.uid,
        adminEmail: req.user.email || 'unknown',
        action: 'SYNC_PENDING_PAYMENTS',
        resourceId: 'orders',
        previousState: null,
        newState: { confirmed },
        ipAddress: req.ip,
      });
    }
    return res.status(200).json({ success: true, data: { checked: candidates.length, confirmed } });
  } catch (err) {
    log.error('order.sync_pending_payments_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to sync payments with Razorpay' });
  }
};

/**
 * POST /orders/:id/refund  (admin).  Body: { amount? } — paise-agnostic rupees;
 * omit for a full refund.
 * For Razorpay orders this calls the real Razorpay Refunds API BEFORE flipping
 * state; for COD it just records the refund. Restocks, reverses analytics,
 * releases the coupon, audit-logs.
 */
exports.refundOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection("orders").doc(id);

    // 1. Load + validate (outside the txn — we must call Razorpay before writing)
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: "Order not found" });
    const order = snap.data();
    if (!REFUNDABLE_STATES.includes(order.status)) {
      return res.status(400).json({ success: false, error: "Order is not in a refundable state" });
    }

    // A payment the admin recorded manually (bank transfer / cash / direct UPI)
    // never went through Razorpay — refund it outside and just record it here.
    const isRazorpay = order.customerInfo?.paymentMethod === 'razorpay' && !(order.manualPayment && !order.razorpayPaymentId);
    const fullAmount = Number(order.totalAmount) || 0;
    const requested = req.body?.amount != null ? Number(req.body.amount) : fullAmount;
    if (!Number.isFinite(requested) || requested <= 0 || requested > fullAmount) {
      return res.status(400).json({ success: false, error: "Invalid refund amount" });
    }

    // 2. Real gateway refund for Razorpay
    let refund = null;
    if (isRazorpay) {
      if (!order.razorpayPaymentId) {
        return res.status(400).json({ success: false, error: "Order has no captured Razorpay payment to refund" });
      }
      try {
        refund = await razorpay.payments.refund(order.razorpayPaymentId, {
          amount: Math.round(requested * 100),
          speed: 'normal',
          notes: { orderId: id, admin: req.user.email || req.user.uid },
        });
      } catch (rzpErr) {
        log.error('order.razorpay_refund_failed', { requestId: req.id, orderId: id, err: rzpErr });
        const desc = rzpErr?.error?.description;
        return res.status(502).json({ success: false, error: desc ? `Razorpay: ${desc}` : "Gateway refund failed" });
      }
    }

    // 3. Persist state atomically
    let existingData;
    await runStockTxn(async (t) => {
      const oDoc = await t.get(docRef);
      if (!oDoc.exists) throw new Error("NOT_FOUND");
      const oData = oDoc.data();
      existingData = oData;
      if (!REFUNDABLE_STATES.includes(oData.status)) throw new Error("INVALID_STATE");

      const rev = await readOrderReversal(t, oData);

      t.update(docRef, {
        status: 'refunded',
        refundId: refund?.id || null,
        refundAmount: requested,
        refundStatus: refund?.status || (isRazorpay ? 'processing' : 'manual'),
        refundedBy: req.user.uid,
        refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      applyOrderReversal(t, oData, rev);
      decrementSalesAnalytics(t, oData, isRazorpay ? 'razorpay' : 'cod');
    });

    createAuditLog({
      adminId: req.user.uid,
      adminEmail: req.user.email || 'unknown',
      action: 'REFUND_ORDER',
      resourceId: id,
      previousState: { status: existingData.status },
      newState: { status: 'refunded', refundId: refund?.id || null, amount: requested },
      ipAddress: req.ip,
    });

    const short = `#${id.slice(-6).toUpperCase()}`;
    sendOrderEmail(id, 'refunded', { refundAmount: requested });
    if (existingData.userId) {
      createNotification('admin', 'Refund Processed', `Refund for order ${short} was processed.`, { orderId: id });
    }

    // Stop the parcel (and release the wallet freight hold) if the courier hasn't picked it up.
    const shipmentCancel = existingData.shipment?.srOrderId
      ? await cancelShipmentForOrder(id, { reason: 'refund' })
      : 'not_needed';
    if (shipmentCancel === 'failed') {
      createNotification('admin', 'Cancel shipment manually', `Order ${short} was refunded but its Shiprocket shipment could not be cancelled. Cancel it in the Shiprocket panel.`, { orderId: id });
    }
    return res.status(200).json({ success: true, message: "Refund processed", refundId: refund?.id || null, shipmentCancel });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Order not found" });
    if (err.message === "INVALID_STATE") return res.status(409).json({ success: false, error: "Order was modified — refund aborted, gateway refund may need manual reconciliation" });
    log.error('order.refund_failed', { requestId: req.id, orderId: req.params.id, err });
    return res.status(500).json({ success: false, error: "Failed to process refund" });
  }
};

// NOTE: hard-deleting orders is intentionally NOT exposed — orders are financial
// records. Use cancel / refund instead.

// DELETE /orders/:id  (admin) — permanently removes a CLOSED order. Active paid
// orders must be cancelled or refunded first (which restores stock and money);
// an unpaid `payment_pending` order is checked with Razorpay and its stock
// reservation released before it goes.

// ── OTP-protected deletion (any status) ─────────────────────────────────────
// Admin → Orders can delete any order — including paid ones — after confirming
// a one-time code emailed to the signed-in admin. Every deleted order is first
// copied to `deletedOrders` (full document + who/when) so sales and GST records
// can be recovered, and each deletion is audit-logged.
const DELETE_OTP_COLLECTION = 'orderDeleteOtps';
const MAX_BULK_DELETE = 200;

// POST /api/orders/admin/delete-otp — email a code to the signed-in admin
exports.requestDeleteOtp = async (req, res) => {
  try {
    const email = req.user?.email;
    if (!email) return res.status(400).json({ success: false, error: 'Your admin account has no email address for the code' });
    const otp = await issueOtp(DELETE_OTP_COLLECTION, req.user.uid);
    const { subject, text, html } = buildOtpEmail({ purpose: 'order_delete', otp });
    const sent = await sendMail(email, subject, text, html);
    if (sent && sent.success === false) {
      return res.status(503).json({ success: false, error: 'Could not send the code — email is not configured on the server' });
    }
    const [name, domain] = email.split('@');
    return res.status(200).json({ success: true, data: { sentTo: `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}` } });
  } catch (err) {
    log.error('order.delete_otp_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Could not send the verification code' });
  }
};

// POST /api/orders/admin/delete — { ids: [...], otp }
exports.deleteOrdersWithOtp = async (req, res) => {
  try {
    const ids = [...new Set((req.body?.ids || []).map(String).filter(Boolean))];
    const otp = String(req.body?.otp || '').trim();
    if (!ids.length) return res.status(400).json({ success: false, error: 'Choose at least one order' });
    if (ids.length > MAX_BULK_DELETE) return res.status(400).json({ success: false, error: `Delete at most ${MAX_BULK_DELETE} orders at a time` });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ success: false, error: 'Enter the 6-digit code' });

    const check = await verifyOtp(DELETE_OTP_COLLECTION, req.user.uid, otp);
    if (!check.ok) {
      const msg = check.reason === 'not_requested' ? 'Request a verification code first' : OTP_ERROR_MESSAGE[check.reason];
      return res.status(400).json({ success: false, error: msg });
    }

    const deleted = [];
    const missing = [];
    for (const id of ids) {
      const ref = db.collection('orders').doc(id);
      const snap = await ref.get();
      if (!snap.exists) { missing.push(id); continue; }
      const order = snap.data();
      const status = String(order.status || '').toLowerCase();

      // An unpaid order still holds reserved stock — give it back.
      if (status === 'payment_pending' && order.reservationId) {
        try { await releaseReservation(order.reservationId, 'RELEASED'); } catch (e) { log.warn('order.delete_release_failed', { orderId: id, err: e }); }
      }

      await db.collection('deletedOrders').doc(id).set({
        ...order,
        deletedAt: new Date().toISOString(),
        deletedBy: { uid: req.user.uid, email: req.user.email || null },
      });
      await ref.delete();
      deleted.push(id);

      createAuditLog({
        adminId: req.user?.uid,
        adminEmail: req.user?.email || 'unknown',
        action: 'DELETE_ORDER',
        resourceId: id,
        previousState: {
          status: order.status,
          totalAmount: order.totalAmount,
          customer: order.customerInfo?.email || order.userEmail || null,
          itemCount: (order.items || []).length,
          archivedTo: `deletedOrders/${id}`,
          otpVerified: true,
        },
        newState: null,
        ipAddress: req.ip,
      });
    }

    return res.status(200).json({ success: true, data: { deleted, missing } });
  } catch (err) {
    log.error('order.bulk_delete_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to delete orders' });
  }
};


