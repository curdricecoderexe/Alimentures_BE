const admin = require("firebase-admin");
const db = require("../config/firebase");

const ADDRESS_FIELDS = ['fullName', 'phone', 'street', 'city', 'state', 'pincode'];

/** Validate + normalise an address payload. Returns { data } or { error }. */
function cleanAddress(body, { partial = false } = {}) {
  const out = {};
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  for (const f of ADDRESS_FIELDS) {
    if (body[f] === undefined && partial) continue;
    const v = s(body[f], f === 'street' ? 300 : 120);
    if (!v) return { error: `${f} is required` };
    out[f] = v;
  }
  if (out.phone !== undefined && !/^[0-9+\-\s()]{7,20}$/.test(out.phone)) {
    return { error: "Phone number is invalid" };
  }
  if (out.pincode !== undefined && !/^[A-Za-z0-9\s-]{3,12}$/.test(out.pincode)) {
    return { error: "PIN / ZIP code is invalid" };
  }
  if (body.isDefault !== undefined) out.isDefault = Boolean(body.isDefault);
  return { data: out };
}

// GET addresses
exports.getAddresses = async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.collection("addresses").where("userId", "==", uid).get();
    
    const addresses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.status(200).json({ success: true, data: addresses });
  } catch (err) {
    console.error("Error getting addresses:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// POST address
exports.addAddress = async (req, res) => {
  try {
    const uid = req.user.uid;
    const { data, error } = cleanAddress(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const newAddress = {
      userId: uid,
      ...data,
      isDefault: Boolean(data.isDefault),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    const isDefault = newAddress.isDefault;

    if (isDefault) {
      // Use transaction to set others to false
      await db.runTransaction(async (transaction) => {
        const querySnapshot = await transaction.get(db.collection("addresses").where("userId", "==", uid).where("isDefault", "==", true));
        querySnapshot.forEach(doc => {
          transaction.update(doc.ref, { isDefault: false });
        });
        const newRef = db.collection("addresses").doc();
        transaction.set(newRef, newAddress);
      });
      return res.status(201).json({ success: true, message: "Address added" });
    } else {
      const doc = await db.collection("addresses").add(newAddress);
      return res.status(201).json({ success: true, message: "Address added", id: doc.id });
    }
  } catch (err) {
    console.error("Error adding address:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// PUT address
exports.updateAddress = async (req, res) => {
  try {
    const uid = req.user.uid;
    const addressId = req.params.id;
    const { data: updates, error } = cleanAddress(req.body, { partial: true });
    if (error) return res.status(400).json({ success: false, error });
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: "No valid fields to update" });
    }

    const docRef = db.collection("addresses").doc(addressId);

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) throw new Error("NOT_FOUND");
      if (doc.data().userId !== uid) throw new Error("UNAUTHORIZED");

      if (updates.isDefault) {
        const defaultQuery = await transaction.get(
          db.collection("addresses").where("userId", "==", uid).where("isDefault", "==", true)
        );
        defaultQuery.forEach((d) => {
          if (d.id !== addressId) transaction.update(d.ref, { isDefault: false });
        });
      }

      updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
      transaction.update(docRef, updates);
    });

    return res.status(200).json({ success: true, message: "Address updated" });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Not found" });
    if (err.message === "UNAUTHORIZED") return res.status(403).json({ success: false, error: "Unauthorized" });
    console.error("Error updating address:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// DELETE address
exports.deleteAddress = async (req, res) => {
  try {
    const uid = req.user.uid;
    const addressId = req.params.id;
    
    const docRef = db.collection("addresses").doc(addressId);
    
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) {
        throw new Error("NOT_FOUND");
      }
      if (doc.data().userId !== uid) {
        throw new Error("UNAUTHORIZED");
      }
      transaction.delete(docRef);
    });

    return res.status(200).json({ success: true, message: "Address deleted" });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Not found" });
    if (err.message === "UNAUTHORIZED") return res.status(403).json({ success: false, error: "Unauthorized" });
    console.error("Error deleting address:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

// SET default address
exports.setDefaultAddress = async (req, res) => {
  try {
    const uid = req.user.uid;
    const addressId = req.params.id;

    const docRef = db.collection("addresses").doc(addressId);

    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) {
        throw new Error("NOT_FOUND");
      }
      if (doc.data().userId !== uid) {
        throw new Error("UNAUTHORIZED");
      }
      
      // Reset all defaults for user
      const defaultQuery = await transaction.get(db.collection("addresses").where("userId", "==", uid).where("isDefault", "==", true));
      defaultQuery.forEach(d => {
        if (d.id !== addressId) {
          transaction.update(d.ref, { isDefault: false });
        }
      });
      
      transaction.update(docRef, { isDefault: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    return res.status(200).json({ success: true, message: "Default address set" });
  } catch (err) {
    if (err.message === "NOT_FOUND") return res.status(404).json({ success: false, error: "Not found" });
    if (err.message === "UNAUTHORIZED") return res.status(403).json({ success: false, error: "Unauthorized" });
    console.error("Error setting default address:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};
