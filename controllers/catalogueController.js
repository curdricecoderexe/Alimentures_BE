'use strict';

/**
 * Downloadable product catalogue (PDF) gated by a lead form.
 *
 * Admin uploads the PDF (stored via chunkStore). A visitor submits name +
 * mobile → the lead is saved to `catalogueLeads` and the response carries a
 * short-lived signed link to `/api/catalogue/file`, which streams the PDF as
 * an attachment. Without a valid token the file isn't served.
 *
 * Until a PDF is uploaded, the download is a catalogue generated from the live
 * product list (utils/cataloguePdf.js, token version "auto"), so visitors can
 * always download one.
 */

const crypto = require('crypto');
const db = require('../config/firebase');
const admin = require('../lib/firebaseAdmin');
const log = require('../lib/logger');
const chunkStore = require('../lib/chunkStore');
const { createAuditLog } = require('../services/auditService');
const { getCachedProducts } = require('./productController');
const { buildCataloguePdf } = require('../utils/cataloguePdf');

const AUTO_VERSION = 'auto';
const AUTO_FILENAME = 'Alimenture-Catalogue.pdf';
const AUTO_CACHE_MS = 10 * 60 * 1000;
let _auto = { at: 0, key: '', buf: null };

/** Generated catalogue for the current public products (cached briefly). */
async function autoCatalogue() {
  const products = (await getCachedProducts()).filter((p) => p.isDraft !== true && p.isPrivate !== true);
  const key = products.map((p) => `${p.id}:${p.updatedAt?._seconds || p.updatedAt?.seconds || ''}`).join('|');
  if (_auto.buf && _auto.key === key && Date.now() - _auto.at < AUTO_CACHE_MS) return _auto.buf;
  const buf = await buildCataloguePdf(products);
  _auto = { at: Date.now(), key, buf };
  return buf;
}

const META = () => db.collection('catalogue').doc('current');
const LEADS = 'catalogueLeads';
const store = chunkStore('catalogueChunks');
const TOKEN_TTL_MS = 10 * 60 * 1000;

// Signing key: explicit env var, else derived from the service-account key
// (stable across restarts, never exposed).
const SIGNING_KEY = (() => {
  if (process.env.CATALOGUE_TOKEN_SECRET) return process.env.CATALOGUE_TOKEN_SECRET;
  let material = 'alimenture-catalogue';
  try { material += JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}').private_key || ''; } catch { /* ignore */ }
  return crypto.createHash('sha256').update(material).digest('hex');
})();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', SIGNING_KEY).update(payload).digest('base64url');

function makeToken(version) {
  const payload = b64url(JSON.stringify({ v: version, exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

let _meta = { at: 0, data: null };
const META_CACHE_MS = 60 * 1000;
async function readMeta() {
  if (_meta.data && Date.now() - _meta.at < META_CACHE_MS) return _meta.data;
  const snap = await META().get();
  _meta = { at: Date.now(), data: snap.exists ? snap.data() : {} };
  return _meta.data;
}
const invalidate = () => { _meta = { at: 0, data: null }; };

const fileUrl = (version) => `/api/catalogue/file?token=${encodeURIComponent(makeToken(version))}`;
const safeFilename = (name) => (String(name || 'Alimenture-Catalogue.pdf').replace(/[^\w.\- ]+/g, '').trim() || 'Alimenture-Catalogue.pdf');

/** Indian mobile → 10 digits, or null. Accepts +91 / 0 prefixes, spaces and dashes. */
function normaliseMobile(raw) {
  let d = String(raw || '').replace(/[\s\-()]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

// ─── Public ──────────────────────────────────────────────────────────────────

/** Section copy + whether a catalogue is available. */
exports.getCatalogue = async (req, res) => {
  try {
    const m = await readMeta();
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({
      success: true,
      data: {
        // The section shows whenever it's enabled; without an uploaded PDF the
        // download is generated from the live catalogue.
        available: m.enabled !== false,
        hasFile: true,
        generated: !m.version,
        title: m.title || '',
        description: m.description || '',
        size: m.size || null,
        updatedAt: m.uploadedAt?.toDate ? m.uploadedAt.toDate().toISOString() : null,
      },
    });
  } catch (error) {
    log.error('catalogue.get_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load the catalogue' });
  }
};

/** Save the lead, hand back a short-lived download link. */
exports.submitLead = async (req, res) => {
  try {
    const m = await readMeta();
    if (m.enabled === false) {
      return res.status(404).json({ success: false, error: 'The catalogue is not available right now' });
    }
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || !/^[\p{L} .'-]+$/u.test(name)) {
      return res.status(400).json({ success: false, error: 'Please enter your name' });
    }
    const mobile = normaliseMobile(req.body.mobile);
    if (!mobile) {
      return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit mobile number' });
    }

    await db.collection(LEADS).add({
      name,
      mobile,
      consent: true,
      catalogueVersion: m.version || AUTO_VERSION,
      catalogueFile: m.version ? safeFilename(m.filename) : AUTO_FILENAME,
      userAgent: String(req.get('user-agent') || '').slice(0, 200),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      data: m.version
        ? { downloadUrl: fileUrl(m.version), filename: safeFilename(m.filename) }
        : { downloadUrl: fileUrl(AUTO_VERSION), filename: AUTO_FILENAME },
    });
  } catch (error) {
    log.error('catalogue.lead_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

/** Stream the PDF for a valid token. */
exports.downloadFile = async (req, res) => {
  try {
    const tok = readToken(req.query.token);
    if (!tok) return res.status(403).json({ success: false, error: 'This download link has expired. Please request the catalogue again.' });
    const m = await readMeta();
    const auto = tok.v === AUTO_VERSION && !m.version;
    if (!auto && (!m.version || m.version !== tok.v)) {
      return res.status(410).json({ success: false, error: 'The catalogue has been updated. Please request it again.' });
    }
    const buf = auto ? await autoCatalogue() : await store.read(m.version, m.chunkCount);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(buf.length),
      'Content-Disposition': `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${auto ? AUTO_FILENAME : safeFilename(m.filename)}"`,
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(buf);
  } catch (error) {
    log.error('catalogue.download_failed', { requestId: req.id, err: error });
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to download the catalogue' });
  }
};

// ─── Admin ───────────────────────────────────────────────────────────────────

exports.getAdminCatalogue = async (req, res) => {
  try {
    invalidate();
    const m = await readMeta();
    const leadCount = (await db.collection(LEADS).count().get()).data().count;
    res.set('Cache-Control', 'private, no-store');
    res.json({
      success: true,
      data: {
        hasFile: !!m.version,
        generated: !m.version, // downloads use the auto-generated catalogue
        enabled: m.enabled !== false,
        title: m.title || '',
        description: m.description || '',
        filename: m.filename || null,
        size: m.size || null,
        uploadedAt: m.uploadedAt?.toDate ? m.uploadedAt.toDate().toISOString() : null,
        previewUrl: `${fileUrl(m.version || AUTO_VERSION)}&inline=1`,
        leadCount,
      },
    });
  } catch (error) {
    log.error('catalogue.admin_get_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load the catalogue settings' });
  }
};

exports.updateDetails = async (req, res) => {
  try {
    const patch = {};
    for (const k of ['title', 'description', 'enabled']) if (req.body[k] !== undefined) patch[k] = req.body[k];
    await META().set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    invalidate();
    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_CATALOGUE_DETAILS', resourceId: 'current', previousState: null, newState: patch, ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Catalogue details saved' });
  } catch (error) {
    log.error('catalogue.update_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to save catalogue details' });
  }
};

/** Raw PDF body; `?filename=` names the download. */
exports.uploadFile = async (req, res) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 5 || buf.toString('ascii', 0, 5) !== '%PDF-') {
      return res.status(400).json({ success: false, error: 'Please upload a PDF file' });
    }
    const prevSnap = await META().get();
    const prev = prevSnap.exists ? prevSnap.data() : {};

    const { version, chunkCount } = await store.write(buf);
    const filename = safeFilename(req.query.filename);
    await META().set({
      version, chunkCount, size: buf.length, filename,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      uploadedBy: req.user?.email || 'unknown',
    }, { merge: true });
    invalidate();

    if (prev.version && prev.chunkCount) {
      store.remove(prev.version, prev.chunkCount).catch((err) => log.warn('catalogue.old_chunks_cleanup_failed', { err }));
    }
    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'UPLOAD_CATALOGUE', resourceId: 'current',
      previousState: prev.version ? { filename: prev.filename, size: prev.size } : null,
      newState: { filename, size: buf.length }, ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Catalogue uploaded', data: { filename, size: buf.length } });
  } catch (error) {
    log.error('catalogue.upload_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to upload the catalogue' });
  }
};

exports.deleteFile = async (req, res) => {
  try {
    const snap = await META().get();
    const prev = snap.exists ? snap.data() : {};
    if (!prev.version) return res.json({ success: true, message: 'No catalogue to remove' });
    const del = admin.firestore.FieldValue.delete();
    await META().set({ version: del, chunkCount: del, size: del, filename: del, uploadedAt: del }, { merge: true });
    invalidate();
    await store.remove(prev.version, prev.chunkCount || 0);
    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'DELETE_CATALOGUE', resourceId: 'current', previousState: { filename: prev.filename }, newState: null, ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Uploaded catalogue removed — downloads now use the catalogue generated from your products' });
  } catch (error) {
    log.error('catalogue.delete_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to remove the catalogue' });
  }
};

exports.listLeads = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const snap = await db.collection(LEADS).orderBy('createdAt', 'desc').limit(limit).get();
    res.set('Cache-Control', 'private, no-store');
    res.json({
      success: true,
      data: snap.docs.map((d) => {
        const v = d.data();
        return {
          id: d.id,
          name: v.name,
          mobile: v.mobile,
          catalogueFile: v.catalogueFile || null,
          createdAt: v.createdAt?.toDate ? v.createdAt.toDate().toISOString() : null,
        };
      }),
    });
  } catch (error) {
    log.error('catalogue.leads_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load leads' });
  }
};

exports.deleteLead = async (req, res) => {
  try {
    await db.collection(LEADS).doc(req.params.id).delete();
    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'DELETE_CATALOGUE_LEAD', resourceId: req.params.id, previousState: null, newState: null, ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Lead deleted' });
  } catch (error) {
    log.error('catalogue.lead_delete_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to delete the lead' });
  }
};

// exposed for tests
exports._internals = { normaliseMobile, makeToken, readToken };
