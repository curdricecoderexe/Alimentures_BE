'use strict';

/**
 * FSSAI registration certificate — downloadable from the site footer, gated by
 * the same name + mobile lead form as the catalogue.
 *
 * The certificate PDF ships with the backend (assets/documents/), so it works
 * out of the box. Admin can upload a renewed certificate (stored via
 * chunkStore) which then replaces it; removing the upload falls back to the
 * bundled file. Leads go to the shared `catalogueLeads` collection with
 * `document: 'fssai'`, so Admin → Leads lists catalogue and certificate
 * requests together.
 *
 * Download links are short-lived HMAC tokens (catalogueController helpers)
 * whose version is prefixed "fssai:", so a catalogue link can't fetch the
 * certificate and vice versa.
 */

const fs = require('fs');
const path = require('path');
const db = require('../config/firebase');
const admin = require('../lib/firebaseAdmin');
const log = require('../lib/logger');
const chunkStore = require('../lib/chunkStore');
const { createAuditLog } = require('../services/auditService');
const { _internals: { normaliseMobile, makeToken, readToken } } = require('./catalogueController');

const DOC_KEY = 'fssai';
const LEADS = 'catalogueLeads';
const META = () => db.collection('catalogue').doc('fssai');
const store = chunkStore('documentChunks');

const BUNDLED_PATH = path.join(__dirname, '..', 'assets', 'documents', 'FSSAI-Certificate.pdf');
const BUNDLED_VERSION = 'bundled';
const DEFAULT_FILENAME = 'Alimenture-FSSAI-Certificate.pdf';
const DEFAULTS = Object.freeze({
  title: 'FSSAI registered food business',
  registrationNo: '22424551000152',
  validUpto: '2029-03-31',
});

let _bundled = null;
function bundledPdf() {
  if (!_bundled) _bundled = fs.readFileSync(BUNDLED_PATH);
  return _bundled;
}
const bundledSize = () => { try { return bundledPdf().length; } catch { return null; } };

let _meta = { at: 0, data: null };
const META_CACHE_MS = 60 * 1000;
async function readMeta() {
  if (_meta.data && Date.now() - _meta.at < META_CACHE_MS) return _meta.data;
  const snap = await META().get();
  _meta = { at: Date.now(), data: snap.exists ? snap.data() : {} };
  return _meta.data;
}
const invalidate = () => { _meta = { at: 0, data: null }; };

const tokenVersion = (m) => `${DOC_KEY}:${m.version || BUNDLED_VERSION}`;
const fileUrl = (m) => `/api/catalogue/fssai/file?token=${encodeURIComponent(makeToken(tokenVersion(m)))}`;
const safeFilename = (name) => (String(name || DEFAULT_FILENAME).replace(/[^\w.\- ]+/g, '').trim() || DEFAULT_FILENAME);
const filenameOf = (m) => (m.version ? safeFilename(m.filename) : DEFAULT_FILENAME);

function publicInfo(m) {
  return {
    available: m.enabled !== false,
    title: m.title || DEFAULTS.title,
    registrationNo: m.registrationNo || DEFAULTS.registrationNo,
    validUpto: m.validUpto || DEFAULTS.validUpto,
    size: m.version ? (m.size || null) : bundledSize(),
  };
}

// ─── Public ──────────────────────────────────────────────────────────────────

/** GET /api/catalogue/fssai — what the footer download shows. */
exports.getInfo = async (req, res) => {
  try {
    const m = await readMeta();
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({ success: true, data: publicInfo(m) });
  } catch (error) {
    log.error('fssai.get_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load the certificate' });
  }
};

/** POST /api/catalogue/fssai/leads — save the lead, return a short-lived download link. */
exports.submitLead = async (req, res) => {
  try {
    const m = await readMeta();
    if (m.enabled === false) {
      return res.status(404).json({ success: false, error: 'The certificate is not available right now' });
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
      document: DOC_KEY,
      catalogueVersion: tokenVersion(m),
      catalogueFile: filenameOf(m),
      userAgent: String(req.get('user-agent') || '').slice(0, 200),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, data: { downloadUrl: fileUrl(m), filename: filenameOf(m) } });
  } catch (error) {
    log.error('fssai.lead_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

/** GET /api/catalogue/fssai/file?token= — stream the certificate for a valid token. */
exports.downloadFile = async (req, res) => {
  try {
    const tok = readToken(req.query.token);
    if (!tok || !String(tok.v).startsWith(`${DOC_KEY}:`)) {
      return res.status(403).json({ success: false, error: 'This download link has expired. Please request the certificate again.' });
    }
    const m = await readMeta();
    if (tok.v !== tokenVersion(m)) {
      return res.status(410).json({ success: false, error: 'The certificate has been updated. Please request it again.' });
    }
    const buf = m.version ? await store.read(m.version, m.chunkCount) : bundledPdf();
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(buf.length),
      'Content-Disposition': `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${filenameOf(m)}"`,
      'Cache-Control': 'private, no-store',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(buf);
  } catch (error) {
    log.error('fssai.download_failed', { requestId: req.id, err: error });
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to download the certificate' });
  }
};

// ─── Admin ───────────────────────────────────────────────────────────────────

/** GET /api/catalogue/admin/fssai */
exports.getAdmin = async (req, res) => {
  try {
    invalidate();
    const m = await readMeta();
    const leadCount = (await db.collection(LEADS).where('document', '==', DOC_KEY).count().get()).data().count;
    res.set('Cache-Control', 'private, no-store');
    res.json({
      success: true,
      data: {
        ...publicInfo(m),
        enabled: m.enabled !== false,
        uploaded: !!m.version,
        filename: filenameOf(m),
        uploadedAt: m.uploadedAt?.toDate ? m.uploadedAt.toDate().toISOString() : null,
        previewUrl: `${fileUrl(m)}&inline=1`,
        leadCount,
      },
    });
  } catch (error) {
    log.error('fssai.admin_get_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load the certificate settings' });
  }
};

/** PATCH /api/catalogue/admin/fssai { enabled?, title?, registrationNo?, validUpto? } */
exports.updateDetails = async (req, res) => {
  try {
    const patch = {};
    for (const k of ['enabled', 'title', 'registrationNo', 'validUpto']) if (req.body[k] !== undefined) patch[k] = req.body[k];
    if (patch.registrationNo !== undefined && patch.registrationNo !== '' && !/^\d{14}$/.test(patch.registrationNo)) {
      return res.status(400).json({ success: false, error: 'FSSAI registration number must be 14 digits' });
    }
    if (patch.validUpto !== undefined && patch.validUpto !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(patch.validUpto)) {
      return res.status(400).json({ success: false, error: 'Valid-upto date must be YYYY-MM-DD' });
    }
    await META().set({ ...patch, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    invalidate();
    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_FSSAI_DETAILS', resourceId: DOC_KEY, previousState: null, newState: patch, ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Certificate details saved' });
  } catch (error) {
    log.error('fssai.update_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to save certificate details' });
  }
};

/** PUT /api/catalogue/admin/fssai/file?filename= — raw PDF body (renewed certificate). */
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
      store.remove(prev.version, prev.chunkCount).catch((err) => log.warn('fssai.old_chunks_cleanup_failed', { err }));
    }
    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'UPLOAD_FSSAI_CERTIFICATE', resourceId: DOC_KEY,
      previousState: prev.version ? { filename: prev.filename, size: prev.size } : null,
      newState: { filename, size: buf.length }, ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Certificate uploaded', data: { filename, size: buf.length } });
  } catch (error) {
    log.error('fssai.upload_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to upload the certificate' });
  }
};

/** DELETE /api/catalogue/admin/fssai/file — drop the upload, fall back to the bundled certificate. */
exports.deleteFile = async (req, res) => {
  try {
    const snap = await META().get();
    const prev = snap.exists ? snap.data() : {};
    if (!prev.version) return res.json({ success: true, message: 'Already using the bundled certificate' });
    const del = admin.firestore.FieldValue.delete();
    await META().set({ version: del, chunkCount: del, size: del, filename: del, uploadedAt: del }, { merge: true });
    invalidate();
    await store.remove(prev.version, prev.chunkCount || 0);
    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'DELETE_FSSAI_CERTIFICATE', resourceId: DOC_KEY, previousState: { filename: prev.filename }, newState: null, ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Upload removed — the bundled certificate is used again' });
  } catch (error) {
    log.error('fssai.delete_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to remove the certificate' });
  }
};
