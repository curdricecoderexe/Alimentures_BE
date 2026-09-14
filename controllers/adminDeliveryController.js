/**
 * adminDeliveryController.js — admin CRUD for PIN-code delivery config +
 * global delivery settings + bulk / CSV operations + dashboard summary.
 *
 * Every route is protected by verifyToken + isAdmin + writeLimiter in the
 * route file. Doc id === pincode (natural unique key, O(1) lookup).
 */
'use strict';

const admin = require('firebase-admin');
const db = require('../config/firebase');
const log = require('../lib/logger');
const { createAuditLog } = require('../services/auditService');
const locationService = require('../services/locationService');
const {
  getGlobalSettings, normaliseSettings, invalidateSettingsCache, clampFee, isValidPincode,
} = require('../services/deliveryService');
const {
  PINCODE_COLLECTION, SETTINGS_COLLECTION, SETTINGS_DOC,
  FEE_MIN, FEE_MAX, CSV_HEADERS, BULK_MAX_ROWS, PINCODE_RE,
} = require('../config/deliveryConstants');

const LIST_MAX = 500;

const audit = (req, action, resourceId, prev, next) => createAuditLog({
  adminId: req.user?.uid,
  adminEmail: req.user?.email || 'unknown',
  action,
  resourceId,
  previousState: prev,
  newState: next,
  ipAddress: req.ip,
});

/* ── validation ────────────────────────────────────────────────────────── */

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

/** Validate + normalise one PIN-code payload. Returns { data } or { error }. */
function cleanPincodePayload(body, { partial = false } = {}) {
  const out = {};
  const pincode = str(body.pincode, 6);

  if (!partial || body.pincode !== undefined) {
    if (!PINCODE_RE.test(pincode)) return { error: 'PIN code must be 6 digits and not start with 0' };
    out.pincode = pincode;
  }

  if (!partial || body.state !== undefined) {
    const state = str(body.state, 60);
    if (state && !locationService.isValidState(state)) return { error: `Unknown Indian state: "${state}"` };
    out.state = state;
    out.stateLower = state.toLowerCase();
  }
  if (!partial || body.city !== undefined) {
    const city = str(body.city, 80);
    out.city = city;
    out.cityLower = city.toLowerCase();
  }
  // cross-check city ↔ state when both are present
  const effState = out.state !== undefined ? out.state : null;
  const effCity = out.city !== undefined ? out.city : null;
  if (effState && effCity && !locationService.cityBelongsToState(effCity, effState)) {
    return { error: `"${effCity}" is not a recognised city in ${effState}` };
  }

  if (!partial || body.deliveryAvailable !== undefined) out.deliveryAvailable = bool(body.deliveryAvailable);
  if (!partial || body.fastestDeliveryAvailable !== undefined) out.fastestDeliveryAvailable = bool(body.fastestDeliveryAvailable);
  if (!partial || body.isActive !== undefined) out.isActive = body.isActive === undefined ? true : bool(body.isActive);

  const feeField = (key, src) => {
    if (partial && src[key] === undefined) return null;
    const raw = src[key];
    if (raw === '' || raw == null) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: `${key} must be a number` };
    if (n < FEE_MIN) return { error: `${key} cannot be negative` };
    if (n > FEE_MAX) return { error: `${key} exceeds the maximum of ₹${FEE_MAX}` };
    return Math.round(n);
  };
  for (const [dst, src] of [
    ['standardDeliveryFee', 'deliveryFee'],
    ['fastestDeliveryFee', 'fastestDeliveryFee'],
  ]) {
    const r = feeField(src, body);
    if (r && typeof r === 'object' && r.error) return { error: r.error };
    if (r !== null) out[dst] = r;
  }

  if (!partial || body.standardEta !== undefined) out.standardDeliveryEta = str(body.standardEta, 60);
  if (!partial || body.fastestEta !== undefined) out.fastestDeliveryEta = str(body.fastestEta, 60);
  if (!partial || body.note !== undefined) out.note = str(body.note, 300);

  return { data: out };
}

/* ── summary (dashboard cards) ─────────────────────────────────────────── */

exports.getSummary = async (req, res) => {
  try {
    const snap = await db.collection(PINCODE_COLLECTION).limit(5000).get();
    let total = 0, deliverable = 0, unavailable = 0, fastest = 0, inactive = 0;
    snap.forEach((d) => {
      const o = d.data();
      total += 1;
      if (o.isActive === false) { inactive += 1; return; }
      if (o.deliveryAvailable) deliverable += 1; else unavailable += 1;
      if (o.deliveryAvailable && o.fastestDeliveryAvailable) fastest += 1;
    });
    const settings = await getGlobalSettings({ fresh: true });
    return res.status(200).json({
      success: true,
      data: { total, deliverable, unavailable, fastest, inactive, fastestGloballyEnabled: settings.fastestDeliveryEnabled },
    });
  } catch (err) {
    log.error('admin.delivery.summary_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to load summary' });
  }
};

/* ── list (search / filter / sort / paginate) ─────────────────────────── */

exports.listPincodes = async (req, res) => {
  try {
    const { search = '', state = '', availability = '', fastest = '', sort = 'updatedAt', dir = 'desc' } = req.query;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
    const page = Math.max(1, Number(req.query.page) || 1);

    // Firestore has no OR / substring search — pull a bounded working set and
    // filter/sort/paginate in memory. Fine for a few thousand pincodes.
    let query = db.collection(PINCODE_COLLECTION);
    if (state && locationService.isValidState(state)) query = query.where('state', '==', state);
    const snap = await query.limit(LIST_MAX).get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const q = String(search).trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.pincode.includes(q) || (r.cityLower || '').includes(q) || (r.stateLower || '').includes(q));
    if (availability === 'available') rows = rows.filter((r) => r.deliveryAvailable && r.isActive !== false);
    else if (availability === 'unavailable') rows = rows.filter((r) => !r.deliveryAvailable || r.isActive === false);
    if (fastest === 'yes') rows = rows.filter((r) => r.fastestDeliveryAvailable);
    else if (fastest === 'no') rows = rows.filter((r) => !r.fastestDeliveryAvailable);

    const ms = (v) => (v?.toMillis ? v.toMillis() : v?._seconds ? v._seconds * 1000 : 0);
    const sortKey = ['pincode', 'city', 'state', 'standardDeliveryFee', 'updatedAt', 'createdAt'].includes(sort) ? sort : 'updatedAt';
    rows.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === 'updatedAt' || sortKey === 'createdAt') { av = ms(av); bv = ms(bv); }
      if (typeof av === 'string') { av = av.toLowerCase(); bv = (bv || '').toLowerCase(); }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return dir === 'asc' ? cmp : -cmp;
    });

    const totalMatched = rows.length;
    const start = (page - 1) * limit;
    const pageRows = rows.slice(start, start + limit);

    return res.status(200).json({
      success: true,
      data: pageRows,
      pagination: { page, limit, total: totalMatched, totalPages: Math.max(1, Math.ceil(totalMatched / limit)), capped: snap.size === LIST_MAX },
    });
  } catch (err) {
    log.error('admin.delivery.list_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to list PIN codes' });
  }
};

/* ── create ───────────────────────────────────────────────────────────── */

exports.createPincode = async (req, res) => {
  try {
    // bulk create: { items: [...] }
    if (Array.isArray(req.body.items)) return bulkUpsert(req, res);

    const { data, error } = cleanPincodePayload(req.body);
    if (error) return res.status(400).json({ success: false, error });

    const ref = db.collection(PINCODE_COLLECTION).doc(data.pincode);
    const existing = await ref.get();
    if (existing.exists) return res.status(409).json({ success: false, error: `PIN code ${data.pincode} already exists` });

    const now = admin.firestore.FieldValue.serverTimestamp();
    const doc = {
      deliveryAvailable: true,
      fastestDeliveryAvailable: false,
      standardDeliveryFee: 0,
      fastestDeliveryFee: 0,
      standardDeliveryEta: '',
      fastestDeliveryEta: '',
      note: '',
      isActive: true,
      ...data,
      createdAt: now,
      updatedAt: now,
      updatedBy: req.user?.email || req.user?.uid || null,
    };
    await ref.set(doc);
    audit(req, 'DELIVERY_PINCODE_CREATE', data.pincode, null, { ...data });
    return res.status(201).json({ success: true, data: { id: data.pincode, ...data } });
  } catch (err) {
    log.error('admin.delivery.create_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to create PIN code' });
  }
};

/* ── update ───────────────────────────────────────────────────────────── */

exports.updatePincode = async (req, res) => {
  try {
    const pincode = str(req.params.pincode, 6);
    if (!isValidPincode(pincode)) return res.status(400).json({ success: false, error: 'Invalid PIN code' });

    const ref = db.collection(PINCODE_COLLECTION).doc(pincode);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'PIN code not found' });

    const { data, error } = cleanPincodePayload({ ...req.body, pincode }, { partial: true });
    if (error) return res.status(400).json({ success: false, error });
    delete data.pincode; // id is immutable

    // re-validate city ↔ state against the merged result
    const merged = { ...snap.data(), ...data };
    if (merged.state && merged.city && !locationService.cityBelongsToState(merged.city, merged.state)) {
      return res.status(400).json({ success: false, error: `"${merged.city}" is not a recognised city in ${merged.state}` });
    }

    await ref.update({
      ...data,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user?.email || req.user?.uid || null,
    });
    audit(req, 'DELIVERY_PINCODE_UPDATE', pincode, redact(snap.data()), redact(data));
    return res.status(200).json({ success: true, data: { id: pincode, ...merged } });
  } catch (err) {
    log.error('admin.delivery.update_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to update PIN code' });
  }
};

const redact = (o = {}) => {
  const { createdAt, updatedAt, updatedBy, ...rest } = o;
  return rest;
};

/* ── status toggle (enable / disable) ─────────────────────────────────── */

exports.setStatus = async (req, res) => {
  try {
    const pincode = str(req.params.pincode, 6);
    if (!isValidPincode(pincode)) return res.status(400).json({ success: false, error: 'Invalid PIN code' });
    const ref = db.collection(PINCODE_COLLECTION).doc(pincode);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'PIN code not found' });

    const field = req.body.field === 'isActive' ? 'isActive' : 'deliveryAvailable';
    const next = req.body.value === undefined ? !snap.data()[field] : bool(req.body.value);
    await ref.update({
      [field]: next,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: req.user?.email || req.user?.uid || null,
    });
    audit(req, 'DELIVERY_PINCODE_STATUS', pincode, { [field]: snap.data()[field] }, { [field]: next });
    return res.status(200).json({ success: true, data: { pincode, field, value: next } });
  } catch (err) {
    log.error('admin.delivery.status_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to update status' });
  }
};

/* ── delete ───────────────────────────────────────────────────────────── */

exports.deletePincode = async (req, res) => {
  try {
    const pincode = str(req.params.pincode, 6);
    if (!isValidPincode(pincode)) return res.status(400).json({ success: false, error: 'Invalid PIN code' });
    const ref = db.collection(PINCODE_COLLECTION).doc(pincode);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'PIN code not found' });
    await ref.delete();
    audit(req, 'DELIVERY_PINCODE_DELETE', pincode, redact(snap.data()), null);
    return res.status(200).json({ success: true, message: 'PIN code deleted' });
  } catch (err) {
    log.error('admin.delivery.delete_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to delete PIN code' });
  }
};

/* ── bulk actions ─────────────────────────────────────────────────────── */

exports.bulkAction = async (req, res) => {
  try {
    const { action } = req.body;
    const pincodes = Array.isArray(req.body.pincodes) ? [...new Set(req.body.pincodes.map((p) => str(p, 6)))] : [];
    if (!['enable', 'disable', 'delete', 'enableFastest', 'disableFastest'].includes(action)) {
      return res.status(400).json({ success: false, error: 'Unknown bulk action' });
    }
    const valid = pincodes.filter((p) => isValidPincode(p));
    if (valid.length === 0) return res.status(400).json({ success: false, error: 'No valid PIN codes supplied' });
    if (valid.length > BULK_MAX_ROWS) return res.status(400).json({ success: false, error: `Too many rows (max ${BULK_MAX_ROWS})` });

    let processed = 0;
    for (let i = 0; i < valid.length; i += 400) {
      const batch = db.batch();
      const chunk = valid.slice(i, i + 400);
      const refs = chunk.map((p) => db.collection(PINCODE_COLLECTION).doc(p));
      const snaps = await db.getAll(...refs);
      snaps.forEach((s, idx) => {
        if (!s.exists) return;
        const ref = refs[idx];
        if (action === 'delete') { batch.delete(ref); processed += 1; return; }
        const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: req.user?.email || null };
        if (action === 'enable') patch.deliveryAvailable = true;
        if (action === 'disable') patch.deliveryAvailable = false;
        if (action === 'enableFastest') patch.fastestDeliveryAvailable = true;
        if (action === 'disableFastest') patch.fastestDeliveryAvailable = false;
        batch.update(ref, patch);
        processed += 1;
      });
      await batch.commit();
    }
    audit(req, 'DELIVERY_PINCODE_BULK', action, null, { action, count: processed });
    return res.status(200).json({ success: true, data: { action, requested: valid.length, processed } });
  } catch (err) {
    log.error('admin.delivery.bulk_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Bulk action failed' });
  }
};

/** Shared by POST /pincodes { items } and CSV import. Validates EVERY row first. */
async function bulkUpsert(req, res) {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ success: false, error: 'No rows supplied' });
  if (items.length > BULK_MAX_ROWS) return res.status(400).json({ success: false, error: `Too many rows (max ${BULK_MAX_ROWS})` });

  const cleaned = [];
  const errors = [];
  const seen = new Set();
  items.forEach((raw, i) => {
    const { data, error } = cleanPincodePayload(raw);
    if (error) { errors.push({ row: i + 1, pincode: raw.pincode, error }); return; }
    if (seen.has(data.pincode)) { errors.push({ row: i + 1, pincode: data.pincode, error: 'Duplicate PIN code in payload' }); return; }
    seen.add(data.pincode);
    cleaned.push(data);
  });

  // Atomic-ish: reject the whole import if ANY row is invalid — never partially corrupt.
  if (errors.length > 0) {
    return res.status(422).json({
      success: false,
      error: `${errors.length} of ${items.length} rows are invalid — nothing was imported`,
      data: { errors: errors.slice(0, 50), totalErrors: errors.length },
    });
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  let written = 0;
  for (let i = 0; i < cleaned.length; i += 400) {
    const batch = db.batch();
    for (const d of cleaned.slice(i, i + 400)) {
      const ref = db.collection(PINCODE_COLLECTION).doc(d.pincode);
      batch.set(ref, {
        deliveryAvailable: true, fastestDeliveryAvailable: false,
        standardDeliveryFee: 0, fastestDeliveryFee: 0,
        standardDeliveryEta: '', fastestDeliveryEta: '', note: '', isActive: true,
        ...d,
        createdAt: now, updatedAt: now, updatedBy: req.user?.email || null,
      }, { merge: true });
      written += 1;
    }
    await batch.commit();
  }
  audit(req, 'DELIVERY_PINCODE_IMPORT', 'bulk', null, { rows: written });
  return res.status(200).json({ success: true, data: { imported: written } });
}

/* ── CSV import / export ──────────────────────────────────────────────── */

/** Split one CSV line, honouring double-quoted fields (RFC-4180 subset). */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return { error: 'CSV must contain a header row and at least one data row' };
  const header = splitCsvLine(lines[0]);
  const idx = Object.fromEntries(CSV_HEADERS.map((h) => [h, header.indexOf(h)]));
  if (idx.pincode === -1 || idx.state === -1) return { error: 'CSV header must include at least "pincode" and "state"' };
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const get = (k) => (idx[k] >= 0 ? cells[idx[k]] : undefined);
    return {
      pincode: get('pincode'),
      city: get('city'),
      state: get('state'),
      deliveryAvailable: get('deliveryAvailable'),
      deliveryFee: get('deliveryFee'),
      fastestDeliveryAvailable: get('fastestDeliveryAvailable'),
      fastestDeliveryFee: get('fastestDeliveryFee'),
      standardEta: get('standardEta'),
      fastestEta: get('fastestEta'),
      note: get('note'),
    };
  });
  return { rows };
}

exports.importCsv = async (req, res) => {
  try {
    const csv = typeof req.body.csv === 'string' ? req.body.csv : '';
    if (!csv.trim()) return res.status(400).json({ success: false, error: 'No CSV content provided' });
    if (csv.length > 5 * 1024 * 1024) return res.status(413).json({ success: false, error: 'CSV too large' });
    const parsed = parseCsv(csv);
    if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
    req.body.items = parsed.rows;
    return bulkUpsert(req, res);
  } catch (err) {
    log.error('admin.delivery.import_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'CSV import failed' });
  }
};

exports.exportCsv = async (req, res) => {
  try {
    const snap = await db.collection(PINCODE_COLLECTION).limit(5000).get();
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [CSV_HEADERS.join(',')];
    snap.forEach((d) => {
      const o = d.data();
      lines.push([
        o.pincode, o.city || '', o.state || '',
        o.deliveryAvailable ? 'true' : 'false', o.standardDeliveryFee || 0,
        o.fastestDeliveryAvailable ? 'true' : 'false', o.fastestDeliveryFee || 0,
        o.standardDeliveryEta || '', o.fastestDeliveryEta || '', o.note || '',
      ].map(esc).join(','));
    });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="delivery-pincodes-${Date.now()}.csv"`);
    return res.status(200).send(lines.join('\n'));
  } catch (err) {
    log.error('admin.delivery.export_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Export failed' });
  }
};

/* ── global settings ──────────────────────────────────────────────────── */

exports.getSettings = async (req, res) => {
  try {
    const settings = await getGlobalSettings({ fresh: true });
    return res.status(200).json({ success: true, data: settings });
  } catch (err) {
    log.error('admin.delivery.settings_get_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const prev = await getGlobalSettings({ fresh: true });
    // normaliseSettings clamps every numeric field and coerces booleans →
    // the client cannot inject a negative or absurd fee here either.
    const next = normaliseSettings({ ...prev, ...req.body });
    next.updatedAt = new Date().toISOString();
    next.updatedBy = req.user?.email || req.user?.uid || null;

    await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).set(next, { merge: true });
    invalidateSettingsCache();
    audit(req, 'DELIVERY_SETTINGS_UPDATE', SETTINGS_DOC, prev, next);
    return res.status(200).json({ success: true, data: next });
  } catch (err) {
    log.error('admin.delivery.settings_update_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
};
