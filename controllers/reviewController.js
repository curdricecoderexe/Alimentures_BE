const admin = require("firebase-admin");
const db = require("../config/firebase");
const { createAuditLog } = require("../services/auditService");

const audit = (req, action, resourceId, prev, next) => createAuditLog({
  adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
  action, resourceId, previousState: prev || null, newState: next || null, ipAddress: req.ip,
});

const REVIEW_TITLE_MAX = 100;
const REVIEW_COMMENT_MAX = 1000;

/**
 * Recompute a product's rating aggregate from its approved reviews.
 *
 * Runs OUTSIDE any transaction: Firestore forbids a read after a write inside a
 * single transaction, and the aggregate is fine as eventually-consistent. The
 * `(reviews.productId ASC, status ASC, createdAt DESC)` composite index covers
 * the query.
 */
const recomputeProductAggregate = async (productId) => {
  if (!productId) return;
  try {
    const snap = await db.collection("reviews")
      .where("productId", "==", productId)
      .where("status", "==", "approved")
      .get();
    let total = 0;
    let count = 0;
    snap.forEach((doc) => { total += Number(doc.data().rating) || 0; count++; });
    const averageRating = count > 0 ? Number((total / count).toFixed(1)) : 0;
    await db.collection("products").doc(productId).update({ averageRating, reviewCount: count });
  } catch (err) {
    console.error("Failed to recompute product aggregate for", productId, err);
  }
};

// POST /api/reviews
exports.createReview = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { productId, orderId, rating, title, comment } = req.body;

    if (!productId || !orderId || !rating || !title || !comment) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, error: "Rating must be an integer between 1 and 5" });
    }
    if (String(title).length > REVIEW_TITLE_MAX) return res.status(400).json({ success: false, error: "Title too long" });
    if (String(comment).length > REVIEW_COMMENT_MAX) return res.status(400).json({ success: false, error: "Comment too long" });

    // Verify purchase
    const orderDoc = await db.collection("orders").doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(400).json({ success: false, error: "Order not found" });
    }

    const orderData = orderDoc.data();
    if (orderData.userId !== uid) {
      return res.status(403).json({ success: false, error: "Order does not belong to you" });
    }

    if ((orderData.status || "").toLowerCase() !== "delivered") {
      return res.status(400).json({ success: false, error: "Order must be delivered to review" });
    }

    const containsProduct = orderData.items?.some(item => item.id === productId || item.productId === productId);
    if (!containsProduct) {
      return res.status(400).json({ success: false, error: "Product not in this order" });
    }

    // Check duplicate
    const existing = await db.collection("reviews")
      .where("userId", "==", uid)
      .where("productId", "==", productId)
      .where("orderId", "==", orderId)
      .get();

    if (!existing.empty) {
      return res.status(409).json({ success: false, error: "You have already reviewed this product for this order" });
    }

    const reviewRef = db.collection("reviews").doc();

    await reviewRef.set({
      productId,
      userId: uid,
      orderId,
      rating: Number(rating),
      title: String(title).trim(),
      comment: String(comment).trim(),
      status: "pending",
      verifiedPurchase: true, // we just verified it
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // No aggregate update — the review is pending, not yet visible.

    return res.status(201).json({ success: true, message: "Review submitted and pending approval", id: reviewRef.id });
  } catch (err) {
    console.error("Error creating review:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// PUT /api/reviews/:id
exports.updateReview = async (req, res) => {
  try {
    const uid = req.user.uid;
    const reviewId = req.params.id;
    const { rating, title, comment } = req.body;

    if (title !== undefined && String(title).length > REVIEW_TITLE_MAX) {
      return res.status(400).json({ success: false, error: "Title too long" });
    }
    if (comment !== undefined && String(comment).length > REVIEW_COMMENT_MAX) {
      return res.status(400).json({ success: false, error: "Comment too long" });
    }

    const docRef = db.collection("reviews").doc(reviewId);
    let affectedProductId = null;

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) throw new Error("NOT_FOUND");
      if (doc.data().userId !== uid) throw new Error("UNAUTHORIZED");

      const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

      if (rating !== undefined) {
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("BAD_RATING");
        updates.rating = rating;
      }
      if (title !== undefined) updates.title = String(title).trim();
      if (comment !== undefined) updates.comment = String(comment).trim();

      // An edit sends the review back to moderation.
      updates.status = "pending";

      transaction.update(docRef, updates);

      // If it was approved, it just left the approved set — recompute afterwards.
      if (doc.data().status === "approved") affectedProductId = doc.data().productId;
    });

    if (affectedProductId) await recomputeProductAggregate(affectedProductId);

    return res.status(200).json({ success: true, message: "Review updated" });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Not found" });
    if (err.message === "UNAUTHORIZED") return res.status(403).json({ success: false, error: "Unauthorized" });
    if (err.message === "BAD_RATING") return res.status(400).json({ success: false, error: "Invalid rating" });
    console.error("Error updating review:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// DELETE /api/reviews/:id
exports.deleteReview = async (req, res) => {
  try {
    const uid = req.user.uid;
    const reviewId = req.params.id;

    const docRef = db.collection("reviews").doc(reviewId);
    let affectedProductId = null;

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) throw new Error("NOT_FOUND");
      if (doc.data().userId !== uid) throw new Error("UNAUTHORIZED");

      transaction.delete(docRef);
      if (doc.data().status === "approved") affectedProductId = doc.data().productId;
    });

    if (affectedProductId) await recomputeProductAggregate(affectedProductId);

    return res.status(200).json({ success: true, message: "Review deleted" });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Not found" });
    if (err.message === "UNAUTHORIZED") return res.status(403).json({ success: false, error: "Unauthorized" });
    console.error("Error deleting review:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// GET /api/reviews/product/:productId (PUBLIC - Returns only approved reviews)
exports.getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const snapshot = await db.collection("reviews")
      .where("productId", "==", productId)
      .where("status", "==", "approved")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    // Batch-resolve reviewer names (one getAll instead of N reads)
    const uids = [...new Set(snapshot.docs.map((d) => d.data().userId).filter(Boolean))];
    const nameByUid = {};
    if (uids.length) {
      const userDocs = await db.getAll(...uids.map((u) => db.collection("users").doc(u)));
      userDocs.forEach((u) => { if (u.exists && u.data().name) nameByUid[u.id] = u.data().name; });
    }

    const reviews = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        rating: data.rating,
        title: data.title,
        comment: data.comment,
        createdAt: data.createdAt,
        verifiedPurchase: data.verifiedPurchase,
        userName: nameByUid[data.userId] || "Verified Customer",
      };
    });

    return res.status(200).json({ success: true, data: reviews });
  } catch (err) {
    console.error("Error getting product reviews:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// --- ADMIN MODERATION ENDPOINTS ---

// GET /api/reviews/admin (Admin sees all)
exports.getAdminReviews = async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    let query = db.collection("reviews").orderBy("createdAt", "desc").limit(limit);
    if (req.query.status) query = db.collection("reviews").where("status", "==", req.query.status).orderBy("createdAt", "desc").limit(limit);
    const snapshot = await query.get();
    const reviews = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.status(200).json({ success: true, data: reviews });
  } catch (err) {
    console.error("Error getting admin reviews:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// PATCH /api/reviews/admin/:id/status
exports.moderateReview = async (req, res) => {
  try {
    const reviewId = req.params.id;
    const { status } = req.body; // "approved" | "rejected" | "pending"

    if (!["approved", "rejected", "pending"].includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status" });
    }

    const docRef = db.collection("reviews").doc(reviewId);
    let affectedProductId = null;
    let changed = false;

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) throw new Error("NOT_FOUND");

      const currentStatus = doc.data().status;
      if (currentStatus === status) return; // no-op
      changed = true;

      transaction.update(docRef, {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (currentStatus === "approved" || status === "approved") {
        affectedProductId = doc.data().productId;
      }
    });

    if (affectedProductId) await recomputeProductAggregate(affectedProductId);
    if (changed) audit(req, 'MODERATE_REVIEW', reviewId, null, { status });

    return res.status(200).json({ success: true, message: "Review moderated successfully" });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Not found" });
    console.error("Error moderating review:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// DELETE /api/reviews/admin/:id
exports.adminDeleteReview = async (req, res) => {
  try {
    const reviewId = req.params.id;
    const docRef = db.collection("reviews").doc(reviewId);
    let affectedProductId = null;

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) throw new Error("NOT_FOUND");

      transaction.delete(docRef);
      if (doc.data().status === "approved") affectedProductId = doc.data().productId;
    });

    if (affectedProductId) await recomputeProductAggregate(affectedProductId);
    audit(req, 'DELETE_REVIEW', reviewId, null, null);

    return res.status(200).json({ success: true, message: "Review deleted by admin" });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Not found" });
    console.error("Error admin deleting review:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
