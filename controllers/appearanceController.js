'use strict';

const db = require('../config/firebase');
const admin = require('firebase-admin');
const log = require('../lib/logger');
const { createAuditLog } = require('../services/auditService');
const {
  APPEARANCE_SLOTS,
  APPEARANCE_KEYS,
  APPEARANCE_COLLECTION,
} = require('../config/appearanceSlots');

// Small in-process cache so a homepage load is one Firestore read at most per
// minute regardless of traffic. Invalidated on every write.
let _cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;

/** Public — the { slotKey: imageDataUri|url } map the storefront consumes. */
exports.getAppearance = async (req, res) => {
  try {
    if (_cache.data && Date.now() - _cache.at < CACHE_MS) {
      return res.json({ success: true, data: _cache.data });
    }
    const snap = await db.collection(APPEARANCE_COLLECTION).get();
    const data = {};
    snap.forEach((doc) => {
      const v = doc.data();
      if (APPEARANCE_KEYS.includes(doc.id) && v && v.image) data[doc.id] = v.image;
    });
    _cache = { at: Date.now(), data };
    res.json({ success: true, data });
  } catch (error) {
    log.error('appearance.get_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load appearance settings' });
  }
};

/** Admin — the slot catalogue (labels, groups, hints) for the editor UI. */
exports.getSlots = (req, res) => {
  res.json({ success: true, data: APPEARANCE_SLOTS });
};

/** Admin — set/replace the image for one slot. Image validated by imageField. */
exports.updateAsset = async (req, res) => {
  try {
    const { key } = req.params;
    if (!APPEARANCE_KEYS.includes(key)) {
      return res.status(400).json({ success: false, error: 'Unknown appearance slot' });
    }
    const { image } = req.body;
    if (!image) return res.status(400).json({ success: false, error: 'An image is required' });

    await db.collection(APPEARANCE_COLLECTION).doc(key).set(
      {
        image,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.user?.email || 'unknown',
      },
      { merge: true },
    );
    _cache = { at: 0, data: null };

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_APPEARANCE_ASSET',
      resourceId: key,
      previousState: null,
      newState: { image: '[set]' },
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Background updated' });
  } catch (error) {
    log.error('appearance.update_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to update background' });
  }
};

/** Admin — clear the slot so the storefront falls back to the bundled default. */
exports.deleteAsset = async (req, res) => {
  try {
    const { key } = req.params;
    if (!APPEARANCE_KEYS.includes(key)) {
      return res.status(400).json({ success: false, error: 'Unknown appearance slot' });
    }
    await db.collection(APPEARANCE_COLLECTION).doc(key).delete();
    _cache = { at: 0, data: null };

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'RESET_APPEARANCE_ASSET',
      resourceId: key,
      previousState: { image: '[set]' },
      newState: null,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Reverted to the default background' });
  } catch (error) {
    log.error('appearance.delete_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to reset background' });
  }
};
