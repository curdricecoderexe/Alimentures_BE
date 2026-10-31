'use strict';

/**
 * Homepage brand film.
 *
 * There is no object storage in this project, so an uploaded video is split
 * into sub-1 MB chunks under `homeVideoChunks` (doc ids `${version}_${i}`) and
 * reassembled in memory to serve with HTTP Range support. The `homeVideo/current`
 * doc holds the copy (title/subtitle/enabled) plus the active video's version.
 * With no upload, the storefront plays its bundled default film.
 */

const crypto = require('crypto');
const db = require('../config/firebase');
const admin = require('../lib/firebaseAdmin');
const log = require('../lib/logger');
const { createAuditLog } = require('../services/auditService');

const META_COLLECTION = 'homeVideo';
const META_DOC = 'current';
const CHUNK_COLLECTION = 'homeVideoChunks';
const CHUNK_BYTES = 900 * 1024;
const CHUNKS_PER_BATCH = 8; // keep each commit well under Firestore's 10 MB request cap

const metaRef = () => db.collection(META_COLLECTION).doc(META_DOC);
const chunkRef = (version, i) => db.collection(CHUNK_COLLECTION).doc(`${version}_${i}`);

// Metadata: one Firestore read per minute at most. Video bytes: kept until the
// version changes (a single film, so memory use is bounded by VIDEO_MAX_BYTES).
let _meta = { at: 0, data: null };
const META_CACHE_MS = 60 * 1000;
let _video = { version: null, buf: null, mime: null };
let _loading = null;

async function readMeta() {
  if (_meta.data && Date.now() - _meta.at < META_CACHE_MS) return _meta.data;
  const snap = await metaRef().get();
  const data = snap.exists ? snap.data() : {};
  _meta = { at: Date.now(), data };
  return data;
}

function invalidate() {
  _meta = { at: 0, data: null };
}

async function loadVideo(meta) {
  if (_video.version === meta.version && _video.buf) return _video;
  if (_loading && _loading.version === meta.version) return _loading.promise;

  const promise = (async () => {
    const refs = Array.from({ length: meta.chunkCount }, (_, i) => chunkRef(meta.version, i));
    const snaps = await db.getAll(...refs);
    const parts = snaps.map((s) => {
      if (!s.exists) throw new Error(`missing chunk ${s.id}`);
      return Buffer.from(s.data().data);
    });
    _video = { version: meta.version, buf: Buffer.concat(parts), mime: meta.mime };
    return _video;
  })();
  _loading = { version: meta.version, promise };
  try {
    return await promise;
  } finally {
    _loading = null;
  }
}

async function deleteChunks(version, count) {
  for (let start = 0; start < count; start += 400) {
    const batch = db.batch();
    for (let i = start; i < Math.min(count, start + 400); i++) batch.delete(chunkRef(version, i));
    await batch.commit();
  }
}

// Magic-byte check: MP4/MOV (`ftyp` box at offset 4) or WebM (EBML header).
function sniffVideoType(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return null;
}

/** Public — copy + the active upload's version (null → use the bundled film). */
exports.getHomeVideo = async (req, res) => {
  try {
    const m = await readMeta();
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({
      success: true,
      data: {
        enabled: m.enabled !== false,
        title: m.title || '',
        subtitle: m.subtitle || '',
        version: m.version || null,
        size: m.size || null,
      },
    });
  } catch (error) {
    log.error('home_video.get_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to load the homepage video' });
  }
};

/** Public — stream the uploaded film, honouring Range requests. */
exports.streamHomeVideo = async (req, res) => {
  try {
    const meta = await readMeta();
    if (!meta.version) return res.status(404).json({ success: false, error: 'No uploaded video' });

    const { buf, mime, version } = await loadVideo(meta);
    const total = buf.length;

    // Played from the storefront's origin, so override helmet's same-origin CORP.
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', mime);
    res.set('ETag', `"${version}"`);
    // A ?v= matching the live version is safe to cache forever.
    res.set('Cache-Control', req.query.v === version
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60');

    const range = req.headers.range;
    if (!range) {
      res.set('Content-Length', String(total));
      return res.end(buf);
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start;
    let end;
    if (m && m[1] !== '') {
      start = Number(m[1]);
      end = m[2] !== '' ? Math.min(Number(m[2]), total - 1) : total - 1;
    } else if (m && m[2] !== '') {
      start = Math.max(0, total - Number(m[2])); // suffix range: last N bytes
      end = total - 1;
    }
    if (start === undefined || start > end || start >= total) {
      res.set('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }

    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${total}`);
    res.set('Content-Length', String(end - start + 1));
    return res.end(buf.subarray(start, end + 1));
  } catch (error) {
    log.error('home_video.stream_failed', { requestId: req.id, err: error });
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to stream the video' });
  }
};

/** Admin — update the overlay copy / visibility. */
exports.updateHomeVideoDetails = async (req, res) => {
  try {
    const patch = {};
    for (const k of ['title', 'subtitle', 'enabled']) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    await metaRef().set(
      {
        ...patch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.user?.email || 'unknown',
      },
      { merge: true },
    );
    invalidate();

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_HOME_VIDEO_DETAILS',
      resourceId: META_DOC,
      previousState: null,
      newState: patch,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Video details saved' });
  } catch (error) {
    log.error('home_video.update_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to save video details' });
  }
};

/** Admin — replace the film. Body is the raw video bytes (video/mp4 or video/webm). */
exports.uploadHomeVideo = async (req, res) => {
  try {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ success: false, error: 'Send an MP4 or WebM video file' });
    }
    const mime = sniffVideoType(buf);
    if (!mime) {
      return res.status(400).json({ success: false, error: 'That file is not a valid MP4 or WebM video' });
    }

    const version = crypto.randomBytes(8).toString('hex');
    const chunkCount = Math.ceil(buf.length / CHUNK_BYTES);

    // Write every chunk first; only then point the meta doc at the new version,
    // so viewers never see a half-written film.
    for (let start = 0; start < chunkCount; start += CHUNKS_PER_BATCH) {
      const batch = db.batch();
      for (let i = start; i < Math.min(chunkCount, start + CHUNKS_PER_BATCH); i++) {
        batch.set(chunkRef(version, i), {
          version,
          index: i,
          data: buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES),
        });
      }
      await batch.commit();
    }

    const prevSnap = await metaRef().get();
    const prev = prevSnap.exists ? prevSnap.data() : {};

    await metaRef().set(
      {
        version,
        mime,
        size: buf.length,
        chunkCount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.user?.email || 'unknown',
      },
      { merge: true },
    );
    invalidate();
    _video = { version, buf, mime };

    if (prev.version && prev.chunkCount) {
      deleteChunks(prev.version, prev.chunkCount).catch((err) =>
        log.warn('home_video.old_chunks_cleanup_failed', { requestId: req.id, err }));
    }

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'UPLOAD_HOME_VIDEO',
      resourceId: META_DOC,
      previousState: prev.version ? { version: prev.version, size: prev.size } : null,
      newState: { version, size: buf.length, mime },
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Video uploaded', data: { version, size: buf.length } });
  } catch (error) {
    log.error('home_video.upload_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to upload the video' });
  }
};

/** Admin — drop the uploaded film so the storefront falls back to the bundled one. */
exports.deleteHomeVideo = async (req, res) => {
  try {
    const snap = await metaRef().get();
    const prev = snap.exists ? snap.data() : {};
    if (!prev.version) return res.json({ success: true, message: 'Already using the default video' });

    await metaRef().set(
      {
        version: admin.firestore.FieldValue.delete(),
        mime: admin.firestore.FieldValue.delete(),
        size: admin.firestore.FieldValue.delete(),
        chunkCount: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.user?.email || 'unknown',
      },
      { merge: true },
    );
    invalidate();
    _video = { version: null, buf: null, mime: null };
    await deleteChunks(prev.version, prev.chunkCount || 0);

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'RESET_HOME_VIDEO',
      resourceId: META_DOC,
      previousState: { version: prev.version, size: prev.size },
      newState: null,
      ipAddress: req.ip,
    });

    res.json({ success: true, message: 'Reverted to the default video' });
  } catch (error) {
    log.error('home_video.delete_failed', { requestId: req.id, err: error });
    res.status(500).json({ success: false, error: 'Failed to reset the video' });
  }
};
