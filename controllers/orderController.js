const admin = require("firebase-admin");
const db = require("../config/firebase");
const { sendMail } = require('../utils/mailer');
const { buildOrderEmail } = require('../utils/emailTemplates');
const { buildInvoicePdf } = require('../utils/invoicePdf');
const { computeDeliveryFee, isValidPincode, DeliveryError } = require('../services/deliveryService');
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
 * Finalise a coupon redemption once a Razorpay order is PAID. The redemption was
 * already created (provisionally) inside the order transaction, so this just
 * clears the `pending` flag. Idempotent; tolerates a missing redemption doc.
 */
async function confirmCouponInTxn(t, oData) {
  if (!oData.couponId || !oData.userId) return;
  const redemptionRef = db.collection('couponRedemptions').doc(couponRedemptionId(oData.couponId, oData.userId));
  const snap = await t.get(redemptionRef);
  if (snap.exists) {
    if (snap.data().pending) {
      t.update(redemptionRef, { pending: false, confirmedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    return;
  }
  // Fallback (shouldn't happen with the new flow): record it now.
  t.create(redemptionRef, {
    couponId: oData.couponId,
    code: oData.couponCode || null,
    userId: oData.userId,
    pending: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  t.update(db.collection('coupons').doc(oData.couponId), {
    usedCount: admin.firestore.FieldValue.increment(1),
  });
}

/**
 * Release a provisional (or any) coupon redemption for a user — used when a
 * Razorpay checkout is abandoned or its gateway order fails. Runs in its own
 * transaction; all reads precede all writes.
 */
async function releaseCoupon(couponId, uid) {
  if (!couponId || !uid) return;
  try {
    await db.runTransaction(async (t) => {
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
  for (const item of oData.items || []) {
    const productRef = db.collection("products").doc(item.productId);
    const productDoc = await t.get(productRef);
    if (!productDoc.exists) continue;
    const variants = productDoc.data().variants || [];
    let idx = variants.findIndex((v) => v.weight === item.selectedWeight);
    if (idx === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight) && variants.length > 0) idx = 0;
    if (idx === -1) continue;
    variants[idx].stock = Number(variants[idx].stock) + Number(item.quantity);
    productUpdates.set(item.productId, {
      ref: productRef,
      variants,
      quantityChange: (productUpdates.get(item.productId)?.quantityChange || 0) + Number(item.quantity),
    });
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
    await db.runTransaction(async (t) => {
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
      for (const item of data.items || []) {
        const productRef = db.collection("products").doc(item.productId);
        const productDoc = await t.get(productRef);
        if (productDoc.exists) {
          const productData = productDoc.data();
          let variants = productData.variants || [];
          let variantIndex = variants.findIndex(v => v.weight === item.selectedWeight);
          if (variantIndex === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight)) {
            if (variants.length > 0) variantIndex = 0;
          }
          if (variantIndex !== -1) {
            variants[variantIndex].stock = Number(variants[variantIndex].stock) + Number(item.quantity);
            productUpdates.set(item.productId, {
              ref: productRef,
              variants: variants,
              quantityChange: (productUpdates.get(item.productId)?.quantityChange || 0) + Number(item.quantity)
            });
          }
        }
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
    const snapshot = await db.collection("stockReservations")
      .where("status", "==", "ACTIVE")
      .where("expiresAt", "<", new Date())
      .limit(250) // bounded per run; the cron fires every 5 min
      .get();

    let count = 0;
    for (const doc of snapshot.docs) {
      await releaseReservation(doc.id, 'EXPIRED');
      count++;
    }

    if (res) return res.status(200).json({ success: true, message: `Cleaned up ${count} expired reservations`, hasMore: count === 250 });
  } catch (err) {
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
  const orders = docs.map((doc) => ({ id: doc.id, ...doc.data() }));
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

    return res.status(200).json({ success: true, data: { id: doc.id, ...orderData } });
  } catch (err) {
    console.error("GET ORDER BY ID ERROR:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

const RAZORPAY_RESERVATION_MINUTES = 10;

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

exports.createOrder = async (req, res) => {
  try {
    const { items, couponCode } = req.body;
    const uid = req.user.uid;
    const customerInfo = sanitizeCustomerInfo(req.body.customerInfo, req.user.email);

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Cart is empty" });
    }
    if (!customerInfo.firstName || !customerInfo.address || !customerInfo.city) {
      return res.status(400).json({ success: false, error: "Shipping name, address and city are required" });
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
        image: product.image || '',
        category: product.category || 'General',
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
    try {
      delivery = await computeDeliveryFee({
        pincode: resolvePincode,
        method: deliveryMethod,
        subtotal: calculatedSubtotal,
      });
    } catch (delErr) {
      if (delErr instanceof DeliveryError) {
        return res.status(400).json({ success: false, error: delErr.publicMessage, code: delErr.code });
      }
      throw delErr;
    }
    const shipping = delivery.fee;

    // ── 2. Resolve the coupon by code (existence/active/expiry/min gate here;
    //       the authoritative consume + per-user + usage-limit check is in the txn) ──
    let couponRef = null;
    if (couponCode && typeof couponCode === 'string') {
      const snap = await db.collection("coupons").where("code", "==", couponCode.toUpperCase().trim()).limit(1).get();
      if (!snap.empty) {
        const c = snap.docs[0].data();
        const isExpired = c.expiresAt && new Date(c.expiresAt.toDate ? c.expiresAt.toDate() : c.expiresAt) < new Date();
        const meetsMin = calculatedSubtotal >= (c.minOrderValue || 0);
        if (c.isActive && !isExpired && meetsMin) {
          couponRef = snap.docs[0].ref;
        }
      }
    }

    // ── 3. Transaction: stock, coupon (COD only), order/reservation ──
    const txResult = await db.runTransaction(async (t) => {
      // reads
      const idempRef = idempotencyKey ? db.collection('idempotencyKeys').doc(idempotencyKey) : null;
      if (idempRef) {
        const existing = await t.get(idempRef);
        if (existing.exists) throw new Error("DUPLICATE_CHECKOUT");
      }

      const productUpdates = new Map();
      for (const item of sanitizedItems) {
        const productRef = db.collection("products").doc(item.productId);
        const productDoc = await t.get(productRef);
        if (!productDoc.exists) throw new Error(`Product ${item.productId} not found`);
        const variants = productDoc.data().variants || [];
        let vi = variants.findIndex(v => v.weight === item.selectedWeight);
        if (vi === -1 && (item.selectedWeight === 'Standard' || !item.selectedWeight) && variants.length > 0) vi = 0;
        if (vi === -1) throw new Error(`Variant "${item.selectedWeight || 'Default'}" not found for ${item.name}`);
        const qty = Number(item.quantity);
        if (variants[vi].stock < qty) throw new Error(`Insufficient stock for ${item.name} (${variants[vi].weight})`);
        variants[vi] = { ...variants[vi], stock: Number(variants[vi].stock) - qty };
        productUpdates.set(item.productId, {
          ref: productRef,
          variants,
          quantityChange: (productUpdates.get(item.productId)?.quantityChange || 0) + qty,
        });
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
      const rzpOrder = await razorpay.orders.create({
        amount: Math.round(totalAmount * 100),
        currency: "INR",
        receipt: `rcpt_${Date.now()}`,
      });

      const orderData = {
        ...txResult.baseOrder,
        status: "payment_pending",
        razorpayOrderId: rzpOrder.id,
        reservationId,
      };
      const newOrderRef = await db.collection("orders").add(orderData);
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
      return res.status(502).json({ success: false, error: "Failed to initialize payment gateway" });
    }
  } catch (err) {
    const map = {
      DUPLICATE_CHECKOUT: [409, "Duplicate checkout request detected"],
      COUPON_INVALID: [400, "Coupon is not valid for this order"],
      COUPON_LIMIT: [400, "This coupon has reached its usage limit"],
      COUPON_ALREADY_USED: [400, "You have already used this coupon"],
    };
    if (map[err.message]) {
      const [status, message] = map[err.message];
      return res.status(status).json({ success: false, error: message });
    }
    // t.create() on an existing idempotency key (concurrent duplicate)
    if (err.code === 6 || /ALREADY_EXISTS/i.test(err.message || '')) {
      return res.status(409).json({ success: false, error: "Duplicate checkout request detected" });
    }
    if (/Insufficient stock|not available|not found|Invalid quantity|Variant /.test(err.message || '')) {
      return res.status(400).json({ success: false, error: err.message });
    }
    log.error("order.create_failed", { requestId: req.id, err });
    return res.status(500).json({ success: false, error: "Failed to place order" });
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
    if (orderData.status !== "payment_pending") {
      return res.status(200).json({ success: true, message: "Order already confirmed" });
    }

    await confirmRazorpayPayment(orderId, razorpay_payment_id, 'verify');

    return res.status(200).json({ success: true, message: "Payment verified and order confirmed" });
  } catch (error) {
    log.error("order.verify_razorpay_failed", { requestId: req.id, err: error });
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
async function confirmRazorpayPayment(orderId, paymentId, source) {
  const orderRef = db.collection("orders").doc(orderId);
  let confirmedData = null;

  // Fetch the instrument used (UPI / card / netbanking / wallet) for display.
  let paymentDetails = null;
  try {
    paymentDetails = summarizePayment(await razorpay.payments.fetch(paymentId));
  } catch (e) {
    log.warn('order.payment_fetch_failed', { orderId, err: e });
  }

  await db.runTransaction(async (t) => {
    const oDoc = await t.get(orderRef);
    if (!oDoc.exists || oDoc.data().status !== "payment_pending") return;
    const oData = oDoc.data();

    let newOrderStatus = "pending";
    if (oData.reservationId) {
      const resRef = db.collection("stockReservations").doc(oData.reservationId);
      const resDoc = await t.get(resRef);
      if (resDoc.exists) {
        const resStatus = resDoc.data().status;
        if (resStatus === 'ACTIVE') {
          t.update(resRef, { status: 'CONFIRMED', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        } else if (resStatus !== 'CONFIRMED') {
          newOrderStatus = "payment_successful_no_stock"; // reservation expired, stock released
        }
      }
    }

    // Record the coupon redemption now that payment has actually succeeded.
    await confirmCouponInTxn(t, oData);

    t.update(orderRef, {
      status: newOrderStatus,
      razorpayPaymentId: paymentId,
      ...(paymentDetails ? { paymentDetails } : {}),
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    incrementSalesAnalytics(t, oData, 'razorpay');
    confirmedData = oData;
  });

  if (!confirmedData) return; // someone else already confirmed

  const short = `#${orderId.slice(-6).toUpperCase()}`;
  sendOrderEmail(orderId, 'paid');
  ['admin', 'staff'].forEach((target) => {
    createNotification(target, 'New Paid Order', `Paid order ${short} received via Razorpay${source === 'webhook' ? ' (webhook)' : ''}`);
  });
  if (confirmedData.userId) {
    createNotification(confirmedData.userId, 'Payment Successful', `Your order ${short} has been confirmed.`);
  }
  log.info('order.razorpay_confirmed', { orderId, source });
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
  await db.runTransaction(async (t) => {
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
  if (fresh?.userId) createNotification(fresh.userId, 'Refund Processed', `Your refund for order ${short} is on its way.`);
}

exports.razorpayWebhook = async (req, res) => {
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
    const eventRef = db.collection('webhookEvents').doc(String(eventId));
    const seen = await eventRef.get();
    if (seen.exists) return res.status(200).send('Duplicate event ignored');
    await eventRef.set({
      event: payload.event,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    log.info('webhook.received', { requestId: req.id, event: payload.event, eventId });

    if (payload.event === 'payment.captured') {
      const entity = payload.payload?.payment?.entity || {};
      const razorpayOrderId = entity.order_id;
      const paymentId = entity.id;
      if (razorpayOrderId) {
        const snap = await db.collection("orders").where("razorpayOrderId", "==", razorpayOrderId).limit(1).get();
        if (!snap.empty) {
          await confirmRazorpayPayment(snap.docs[0].id, paymentId, 'webhook');
        }
      }
    } else if (payload.event === 'refund.processed' || payload.event === 'refund.created') {
      // Dashboard-initiated refunds — reconcile them back to the order.
      await reconcileDashboardRefund(payload.payload?.refund?.entity || {});
    }

    return res.status(200).send('Webhook processed');
  } catch (error) {
    log.error("webhook.error", { requestId: req.id, err: error });
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

    await db.runTransaction(async (t) => {
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
    ['admin', 'staff'].forEach((target) => {
      createNotification(target, 'Order Status Updated', `Order #${id.slice(-6).toUpperCase()} is now ${status.replace(/_/g, ' ')}`);
    });
    if (existingData.userId) {
      createNotification(existingData.userId, 'Order Update', `Your order #${id.slice(-6).toUpperCase()} is now ${status.replace(/_/g, ' ')}`);
    }

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
    if (order.reservationId) {
      await releaseReservation(order.reservationId, 'RELEASED');
    }
    return res.status(200).json({ success: true, message: "Payment attempt released" });
  } catch (err) {
    log.error('order.abandon_payment_failed', { requestId: req.id, orderId: req.params.id, err });
    return res.status(500).json({ success: false, error: "Failed to release payment attempt" });
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

    const isRazorpay = order.customerInfo?.paymentMethod === 'razorpay';
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
    await db.runTransaction(async (t) => {
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
      createNotification(existingData.userId, 'Refund Processed', `Your refund for order ${short} is on its way.`);
    }
    return res.status(200).json({ success: true, message: "Refund processed", refundId: refund?.id || null });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Order not found" });
    if (err.message === "INVALID_STATE") return res.status(409).json({ success: false, error: "Order was modified — refund aborted, gateway refund may need manual reconciliation" });
    log.error('order.refund_failed', { requestId: req.id, orderId: req.params.id, err });
    return res.status(500).json({ success: false, error: "Failed to process refund" });
  }
};

// NOTE: hard-deleting orders is intentionally NOT exposed — orders are financial
// records. Use cancel / refund instead.

