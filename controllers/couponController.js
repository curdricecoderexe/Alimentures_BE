const admin = require("firebase-admin");
const db = require("../config/firebase");
const { createAuditLog } = require("../services/auditService");

const audit = (req, action, resourceId, prev, next) => createAuditLog({
  adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
  action, resourceId, previousState: prev || null, newState: next || null, ipAddress: req.ip,
});

// Helper: Generate a random alphanumeric coupon code
const generateCode = (prefix = "ALIM", length = 8) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = prefix + "-";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

// POST /api/coupons/generate — Admin: generate a new coupon
exports.generateCoupon = async (req, res) => {
  try {
    const {
      prefix = "ALIM",
      discountType = "percentage", // "percentage" | "flat"
      discountValue,
      minOrderValue = 0,
      maxUsage = 1,
      expiresAt,
      description = "",
      customCode,
    } = req.body;

    if (!discountValue || Number(discountValue) <= 0) {
      return res.status(400).json({ success: false, error: "discountValue is required and must be > 0" });
    }
    if (!["percentage", "flat"].includes(discountType)) {
      return res.status(400).json({ success: false, error: "discountType must be 'percentage' or 'flat'" });
    }
    if (discountType === "percentage" && Number(discountValue) > 100) {
      return res.status(400).json({ success: false, error: "Percentage discount cannot exceed 100%" });
    }
    const maxUsageNum = Math.max(1, Math.min(100000, Math.floor(Number(maxUsage) || 1)));

    const code = customCode ? String(customCode).toUpperCase().trim().slice(0, 40) : generateCode(prefix);

    // Check if code already exists
    const existing = await db.collection("coupons").where("code", "==", code).get();
    if (!existing.empty) {
      return res.status(409).json({ success: false, error: "Coupon code already exists. Try a different code." });
    }

    const couponData = {
      code,
      discountType,
      discountValue: Number(discountValue),
      minOrderValue: Number(minOrderValue) || 0,
      maxUsage: maxUsageNum,
      usedCount: 0,
      isActive: true,
      description,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user?.uid || "admin",
    };

    const docRef = await db.collection("coupons").add(couponData);
    audit(req, 'CREATE_COUPON', docRef.id, null, { code, discountType, discountValue: couponData.discountValue, maxUsage: maxUsageNum });

    return res.status(201).json({
      success: true,
      message: "Coupon generated successfully",
      coupon: { id: docRef.id, ...couponData },
    });
  } catch (err) {
    console.error("GENERATE COUPON ERROR:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// GET /api/coupons — Admin: get all coupons
// usedCount is now maintained atomically at order time (orderController), so it
// is authoritative — no order-scan reconciliation needed.
exports.getAllCoupons = async (req, res) => {
  try {
    const snapshot = await db.collection("coupons").orderBy("createdAt", "desc").limit(500).get();
    const coupons = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.status(200).json({ success: true, data: coupons });
  } catch (err) {
    console.error("GET COUPONS ERROR:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch coupons" });
  }
};

// DELETE /api/coupons/:id — Admin: delete a coupon
exports.deleteCoupon = async (req, res) => {
  try {
    const docRef = db.collection("coupons").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Coupon not found" });

    await docRef.delete();
    audit(req, 'DELETE_COUPON', req.params.id, { code: doc.data().code }, null);
    return res.status(200).json({ success: true, message: "Coupon deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Delete failed" });
  }
};

// PATCH /api/coupons/:id/toggle — Admin: toggle active/inactive
exports.toggleCoupon = async (req, res) => {
  try {
    const docRef = db.collection("coupons").doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Coupon not found" });

    const newStatus = !doc.data().isActive;
    await docRef.update({ isActive: newStatus });
    audit(req, 'TOGGLE_COUPON', req.params.id, { isActive: !newStatus }, { isActive: newStatus });
    return res.status(200).json({ success: true, isActive: newStatus });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Toggle failed" });
  }
};

// POST /api/coupons/validate — Customer: validate & apply coupon (preview only;
// the authoritative check + consumption happens atomically at order creation).
exports.validateCoupon = async (req, res) => {
  try {
    const { code, orderValue } = req.body;

    if (!code || typeof code !== "string") return res.status(400).json({ success: false, error: "Coupon code is required" });

    const snapshot = await db.collection("coupons").where("code", "==", code.toUpperCase().trim()).limit(1).get();

    if (snapshot.empty) {
      return res.status(404).json({ success: false, error: "Invalid coupon code" });
    }

    const couponDoc = snapshot.docs[0];
    const coupon = { id: couponDoc.id, ...couponDoc.data() };

    if (!coupon.isActive) {
      return res.status(400).json({ success: false, error: "This coupon is no longer active" });
    }

    if (coupon.expiresAt && new Date(coupon.expiresAt.toDate ? coupon.expiresAt.toDate() : coupon.expiresAt) < new Date()) {
      return res.status(400).json({ success: false, error: "This coupon has expired" });
    }

    if ((coupon.usedCount || 0) >= (coupon.maxUsage || 1)) {
      return res.status(400).json({ success: false, error: "Coupon usage limit reached" });
    }

    // One redemption per customer
    const redemption = await db.collection("couponRedemptions").doc(`${coupon.id}_${req.user.uid}`).get();
    if (redemption.exists) {
      return res.status(400).json({ success: false, error: "You have already used this coupon" });
    }

    const value = Number(orderValue) || 0;
    if (value < coupon.minOrderValue) {
      return res.status(400).json({
        success: false,
        error: `Minimum order value of ₹${coupon.minOrderValue} required to use this coupon`,
      });
    }

    let discountAmount = 0;
    if (coupon.discountType === "percentage") {
      discountAmount = Math.round((value * coupon.discountValue) / 100);
    } else {
      discountAmount = Math.min(coupon.discountValue, value);
    }

    return res.status(200).json({
      success: true,
      message: "Coupon applied successfully!",
      coupon: {
        id: coupon.id,
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        description: coupon.description,
      },
      discountAmount,
      finalAmount: Math.max(0, value - discountAmount),
    });
  } catch (err) {
    console.error("VALIDATE COUPON ERROR:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
