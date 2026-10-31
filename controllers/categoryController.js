'use strict';

/**
 * Product categories — the admin-managed list behind the shop's category
 * filter and the product editor's category picker.
 *
 * Products still store the category *name* (`product.category`), so a rename
 * rewrites every product that used the old name, and a category that still has
 * products cannot be deleted (hide it instead).
 */

const db = require('../config/firebase');
const admin = require('../lib/firebaseAdmin');
const log = require('../lib/logger');
const { createAuditLog } = require('../services/auditService');
const { getCachedProducts, invalidateProductCache } = require('./productController');
const { requestSiteRebuild } = require('../services/siteRebuild');

const COLLECTION = 'categories';
const DEFAULT_CATEGORIES = ['Cookies', 'Health Mixtures', 'Honey', 'Jaggery'];

const norm = (s) => String(s || '').trim().toLowerCase();

let _cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;
const invalidate = () => {
  _cache = { at: 0, data: null };
  requestSiteRebuild('categories changed'); // category pages are pre-rendered
};

async function readAll() {
  const snap = await db.collection(COLLECTION).orderBy('order', 'asc').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** First run: seed the defaults plus any category products already use. */
async function seedIfEmpty() {
  const existing = await readAll();
  if (existing.length) return existing;

  const names = [...DEFAULT_CATEGORIES];
  for (const p of await getCachedProducts()) {
    const name = String(p.category || '').trim();
    if (name && !names.some((n) => norm(n) === norm(name))) names.push(name);
  }
  const batch = db.batch();
  names.forEach((name, order) => {
    batch.set(db.collection(COLLECTION).doc(), {
      name, order, visible: true, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  invalidate();
  return readAll();
}

/** { lowercased name → count } over the products the caller can see. */
async function productCounts({ includeHidden }) {
  const counts = {};
  for (const p of await getCachedProducts()) {
    if (!includeHidden && (p.isDraft === true || p.isPrivate === true)) continue;
    const key = norm(p.category);
    if (key) counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

const shape = (c, counts) => ({
  id: c.id,
  name: c.name,
  order: c.order ?? 0,
  visible: c.visible !== false,
  productCount: counts[norm(c.name)] || 0,
});

/** Public — visible categories in display order, with live product counts. */
exports.getCategories = async (req, res) => {
  try {
    if (!_cache.data || Date.now() - _cache.at > CACHE_MS) {
      const list = await seedIfEmpty();
      const counts = await productCounts({ includeHidden: false });
      _cache = { at: Date.now(), data: list.filter((c) => c.visible !== false).map((c) => shape(c, counts)) };
    }
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({ success: true, data: _cache.data });
  } catch (error) {
    log.error('category.list_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load categories' });
  }
};

/** Admin — every category (hidden too), counting drafts/private products. */
exports.getAdminCategories = async (req, res) => {
  try {
    const list = await seedIfEmpty();
    const counts = await productCounts({ includeHidden: true });
    // Product categories that aren't in the managed list yet (e.g. typed by hand).
    const known = new Set(list.map((c) => norm(c.name)));
    const unmanaged = [];
    for (const p of await getCachedProducts()) {
      const name = String(p.category || '').trim();
      if (name && !known.has(norm(name))) { known.add(norm(name)); unmanaged.push(name); }
    }
    res.set('Cache-Control', 'private, no-store');
    res.json({
      success: true,
      data: list.map((c) => shape(c, counts)),
      unmanaged: unmanaged.map((name) => ({ name, productCount: counts[norm(name)] || 0 })),
    });
  } catch (error) {
    log.error('category.admin_list_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load categories' });
  }
};

exports.createCategory = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'Category name is required' });

    const list = await seedIfEmpty();
    if (list.some((c) => norm(c.name) === norm(name))) {
      return res.status(409).json({ success: false, error: `“${name}” already exists` });
    }
    const order = list.reduce((m, c) => Math.max(m, c.order ?? 0), -1) + 1;
    const ref = await db.collection(COLLECTION).add({
      name, order, visible: true, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    invalidate();

    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'CREATE_CATEGORY', resourceId: ref.id, previousState: null, newState: { name }, ipAddress: req.ip,
    });
    res.status(201).json({ success: true, data: { id: ref.id, name, order, visible: true, productCount: 0 } });
  } catch (error) {
    log.error('category.create_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to create category' });
  }
};

/** Admin — rename and/or show/hide. A rename moves its products along with it. */
exports.updateCategory = async (req, res) => {
  try {
    const ref = db.collection(COLLECTION).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Category not found' });
    const prev = snap.data();

    const patch = {};
    if (typeof req.body.visible === 'boolean') patch.visible = req.body.visible;

    let moved = 0;
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ success: false, error: 'Category name is required' });
      if (name !== prev.name) {
        const list = await readAll();
        if (list.some((c) => c.id !== ref.id && norm(c.name) === norm(name))) {
          return res.status(409).json({ success: false, error: `“${name}” already exists` });
        }
        patch.name = name;

        // Rewrite products that carried the old name (any casing).
        const targets = (await getCachedProducts()).filter((p) => norm(p.category) === norm(prev.name));
        for (let i = 0; i < targets.length; i += 400) {
          const batch = db.batch();
          targets.slice(i, i + 400).forEach((p) => batch.update(db.collection('products').doc(p.id), { category: name }));
          await batch.commit();
        }
        moved = targets.length;
        if (moved) invalidateProductCache();
      }
    }

    if (!Object.keys(patch).length) return res.json({ success: true, message: 'Nothing to change' });
    await ref.update({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    invalidate();

    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_CATEGORY', resourceId: ref.id,
      previousState: { name: prev.name, visible: prev.visible !== false },
      newState: { ...patch, productsMoved: moved }, ipAddress: req.ip,
    });
    res.json({
      success: true,
      message: moved ? `Saved — ${moved} product${moved === 1 ? '' : 's'} moved to “${patch.name}”` : 'Category saved',
    });
  } catch (error) {
    log.error('category.update_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to update category' });
  }
};

/** Admin — persist a new display order: body { ids: [...] } top to bottom. */
exports.reorderCategories = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string') : [];
    if (!ids.length || ids.length > 200) {
      return res.status(400).json({ success: false, error: 'Send the category ids in their new order' });
    }
    const batch = db.batch();
    ids.forEach((id, order) => batch.update(db.collection(COLLECTION).doc(id), { order }));
    await batch.commit();
    invalidate();
    res.json({ success: true, message: 'Order saved' });
  } catch (error) {
    log.error('category.reorder_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to save the order' });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    const ref = db.collection(COLLECTION).doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Category not found' });
    const { name } = snap.data();

    const counts = await productCounts({ includeHidden: true });
    const inUse = counts[norm(name)] || 0;
    if (inUse) {
      return res.status(409).json({
        success: false,
        error: `${inUse} product${inUse === 1 ? ' uses' : 's use'} “${name}”. Move ${inUse === 1 ? 'it' : 'them'} to another category first, or hide this one.`,
      });
    }
    await ref.delete();
    invalidate();

    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'DELETE_CATEGORY', resourceId: ref.id, previousState: { name }, newState: null, ipAddress: req.ip,
    });
    res.json({ success: true, message: `“${name}” deleted` });
  } catch (error) {
    log.error('category.delete_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to delete category' });
  }
};
