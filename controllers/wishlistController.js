const admin = require("firebase-admin");
const db = require("../config/firebase");

// GET wishlist
exports.getWishlist = async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.collection("wishlist").where("userId", "==", uid).limit(200).get();
    if (snapshot.empty) return res.status(200).json({ success: true, data: [] });

    // Single batched read instead of one-per-item (N+1).
    const productIds = [...new Set(snapshot.docs.map((d) => d.data().productId).filter(Boolean))];
    const productDocs = await db.getAll(...productIds.map((id) => db.collection("products").doc(id)));
    const productById = {};
    productDocs.forEach((p) => {
      if (p.exists && p.data().isActive !== false && p.data().isDraft !== true && p.data().isPrivate !== true) {
        productById[p.id] = { id: p.id, ...p.data() };
      }
    });

    const items = snapshot.docs
      .map((doc) => {
        const data = doc.data();
        const product = productById[data.productId];
        return product ? { wishlistId: doc.id, productId: data.productId, addedAt: data.addedAt, product } : null;
      })
      .filter(Boolean);

    return res.status(200).json({ success: true, data: items });
  } catch (err) {
    console.error("Error getting wishlist:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// POST wishlist
exports.addWishlist = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({ success: false, error: "Product ID required" });
    }

    // Verify product exists and is active
    const productDoc = await db.collection("products").doc(productId).get();
    if (!productDoc.exists || productDoc.data().isActive === false) {
      return res.status(404).json({ success: false, error: "Product not found or inactive" });
    }

    // Check for duplicates
    const existing = await db.collection("wishlist")
      .where("userId", "==", uid)
      .where("productId", "==", productId)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(409).json({ success: false, error: "Product already in wishlist" });
    }

    const newDoc = await db.collection("wishlist").add({
      userId: uid,
      productId: productId,
      addedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.status(201).json({ success: true, message: "Added to wishlist", id: newDoc.id });
  } catch (err) {
    console.error("Error adding to wishlist:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// DELETE wishlist item
exports.removeWishlist = async (req, res) => {
  try {
    const uid = req.user.uid;
    const wishlistId = req.params.id; // Either wishlist document ID or productId
    
    // First try by wishlist document ID
    let docRef = db.collection("wishlist").doc(wishlistId);
    let doc = await docRef.get();
    
    // If not found, check if they passed a productId instead
    if (!doc.exists) {
      const byProductId = await db.collection("wishlist")
        .where("userId", "==", uid)
        .where("productId", "==", wishlistId)
        .limit(1)
        .get();
        
      if (!byProductId.empty) {
        docRef = byProductId.docs[0].ref;
        doc = byProductId.docs[0];
      }
    }

    if (!doc.exists) {
      return res.status(404).json({ success: false, error: "Wishlist item not found" });
    }

    if (doc.data().userId !== uid) {
      return res.status(403).json({ success: false, error: "Unauthorized" });
    }

    await docRef.delete();

    return res.status(200).json({ success: true, message: "Removed from wishlist" });
  } catch (err) {
    console.error("Error removing from wishlist:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
