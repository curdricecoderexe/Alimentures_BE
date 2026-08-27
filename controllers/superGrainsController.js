const admin = require("firebase-admin");
const db = require("../config/firebase");

const validateSuperGrain = (data, isUpdate = false) => {
  const fields = ['name', 'local', 'benefit', 'image'];
  
  for (let field of fields) {
    if (!isUpdate && !data[field]) return `${field} is required`;
  }
  return null;
};

exports.createSuperGrain = async (req, res) => {
  try {
    const error = validateSuperGrain(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const grainData = {
      name: req.body.name.trim(),
      local: req.body.local.trim(),
      benefit: req.body.benefit.trim(),
      image: req.body.image,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const doc = await db.collection("super_grains").add(grainData);

    return res.status(201).json({ success: true, id: doc.id });
  } catch (err) {
    console.error("CREATE SUPER GRAIN ERROR:", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
};

exports.getSuperGrains = async (req, res) => {
  try {
    const snapshot = await db.collection("super_grains").orderBy("createdAt", "asc").get();
    const grains = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return res.status(200).json({
      success: true,
      data: grains
    });
  } catch (err) {
    console.error("GET SUPER GRAINS ERROR:", err);
    return res.status(500).json({ success: false, error: "Failed to fetch super grains" });
  }
};

exports.updateSuperGrain = async (req, res) => {
  try {
    const { id } = req.params;
    const error = validateSuperGrain(req.body, true);
    if (error) return res.status(400).json({ success: false, error });

    const updates = {};
    if (req.body.name) updates.name = req.body.name.trim();
    if (req.body.local) updates.local = req.body.local.trim();
    if (req.body.benefit) updates.benefit = req.body.benefit.trim();
    if (req.body.image) updates.image = req.body.image;
    
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    const docRef = db.collection("super_grains").doc(id);
    const existing = await docRef.get();

    if (!existing.exists) return res.status(404).json({ success: false, error: "Super Grain not found" });

    await docRef.update(updates);
    return res.status(200).json({ success: true, message: "Super Grain updated" });
  } catch (err) {
    console.error("UPDATE SUPER GRAIN ERROR:", err);
    return res.status(500).json({ success: false, error: "Update failed" });
  }
};

exports.deleteSuperGrain = async (req, res) => {
  try {
    const docRef = db.collection("super_grains").doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ success: false, error: "Not found" });

    await docRef.delete();
    return res.status(200).json({ success: true, message: "Super Grain deleted" });
  } catch (err) {
    console.error("DELETE SUPER GRAIN ERROR:", err);
    return res.status(500).json({ success: false, error: "Delete failed" });
  }
};
