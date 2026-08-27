const db = require('../config/firebase');
const admin = require('firebase-admin');

const WRITABLE = ['src', 'title', 'subtitle', 'ctaText', 'ctaLink', 'order'];

const pickWritable = (body) => {
  const out = {};
  for (const k of WRITABLE) if (body[k] !== undefined) out[k] = body[k];
  return out;
};

exports.getSlides = async (req, res, next) => {
  try {
    const snapshot = await db.collection('heroSlides').orderBy('createdAt', 'asc').get();
    const slides = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, data: slides });
  } catch (err) {
    next(err);
  }
};

exports.createSlide = async (req, res, next) => {
  try {
    const slideData = {
      ...pickWritable(req.body),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const docRef = await db.collection('heroSlides').add(slideData);
    res.status(201).json({ success: true, data: { id: docRef.id } });
  } catch (err) {
    next(err);
  }
};

exports.updateSlide = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = pickWritable(req.body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    const ref = db.collection('heroSlides').doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ success: false, error: 'Slide not found' });

    await ref.update(updates);
    res.json({ success: true, message: 'Slide updated successfully' });
  } catch (err) {
    next(err);
  }
};

exports.deleteSlide = async (req, res, next) => {
  try {
    const { id } = req.params;
    const ref = db.collection('heroSlides').doc(id);
    const existing = await ref.get();
    if (!existing.exists) return res.status(404).json({ success: false, error: 'Slide not found' });
    await ref.delete();
    res.json({ success: true, message: 'Slide deleted successfully' });
  } catch (err) {
    next(err);
  }
};
