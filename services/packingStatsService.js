/**
 * packingStatsService.js — learns how much heavier real parcels are than the
 * base estimate, per order composition + package.
 *
 * Every verified packing (staff weighed the parcel) records one sample:
 *   diffKg = actual dead weight − base estimate
 *   (base = contents + inner packaging + tare + filler + tape, i.e. WITHOUT the
 *    learned and safety allowances, so the learned value never feeds on itself)
 *
 * Samples are kept per key `${compositionSignature}|${boxId}` and
 * `${compositionSignature}|*` in `packingStats/{hash}` as a rolling window.
 * The learned allowance is a percentile (default P75) of the window after
 * trimming outliers (outside median ± 3 × MAD), clamped to [0, maxAllowanceKg],
 * and only applied once `minSamples` samples exist. One unusual shipment can
 * therefore never move the estimate on its own. Admins can pin an override.
 *
 * Deliberately plain statistics — no ML infrastructure.
 */
'use strict';

const crypto = require('crypto');
const admin = require('../lib/firebaseAdmin');
const db = require('../config/firebase');
const log = require('../lib/logger');

const COLLECTION = 'packingStats';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_DOCS = 1000;

const docId = (key) => crypto.createHash('sha1').update(key).digest('hex').slice(0, 24);
const round3 = (n) => Math.round(n * 1000) / 1000;

function median(sorted) {
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Robust allowance from a list of diffs (kg).
 * @returns {{ allowanceKg: number, used: number, trimmed: number, medianKg: number }}
 */
function computeAllowance(diffs, { percentile: p = 75, maxAllowanceKg = 0.3 } = {}) {
  const xs = diffs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return { allowanceKg: 0, used: 0, trimmed: 0, medianKg: 0 };
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)).sort((a, b) => a - b));
  // MAD of 0 (identical samples) keeps everything within 1 g of the median.
  const band = Math.max(3 * mad * 1.4826, 0.001);
  const kept = xs.filter((x) => Math.abs(x - med) <= band);
  const value = percentile(kept, p);
  return {
    allowanceKg: round3(Math.min(maxAllowanceKg, Math.max(0, value))),
    used: kept.length,
    trimmed: xs.length - kept.length,
    medianKg: round3(med),
  };
}

let _cache = { at: 0, map: null };
function invalidate() { _cache = { at: 0, map: null }; }

/** { key: { allowanceKg, samples, overrideKg } } for the estimator. Never throws. */
async function getLearnedMap({ fresh = false } = {}) {
  if (!fresh && _cache.map && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.map;
  const map = {};
  try {
    const snap = await db.collection(COLLECTION).limit(MAX_DOCS).get();
    snap.forEach((d) => {
      const s = d.data();
      if (!s?.key) return;
      map[s.key] = {
        allowanceKg: Number(s.allowanceKg) || 0,
        samples: Number(s.samples) || 0,
        overrideKg: s.overrideKg == null ? null : Number(s.overrideKg),
      };
    });
  } catch (err) {
    log.warn('packing_stats.read_failed', { err });
  }
  _cache = { at: Date.now(), map };
  return map;
}

/**
 * Record one verified packing for both the box-specific and the any-box key.
 * @param {{ signature, boxId, baseEstimateKg, actualKg, orderId, categories? }} sample
 * @param {{ windowSize, percentile, maxAllowanceKg }} learning
 */
async function recordSample(sample, learning) {
  const { signature, boxId, baseEstimateKg, actualKg, orderId } = sample;
  if (!signature || !(baseEstimateKg > 0) || !(actualKg > 0)) return;
  const diffKg = round3(actualKg - baseEstimateKg);
  const keys = [`${signature}|${boxId || '*'}`];
  if (boxId) keys.push(`${signature}|*`);
  try {
    await Promise.all(keys.map((key) => db.runTransaction(async (t) => {
      const ref = db.collection(COLLECTION).doc(docId(key));
      const snap = await t.get(ref);
      const prev = snap.exists ? snap.data() : {};
      // One sample per order per key — re-verification replaces the order's sample.
      const window = (prev.window || []).filter((w) => w.orderId !== orderId);
      window.push({ orderId: orderId || null, diffKg, at: new Date().toISOString() });
      const trimmedWindow = window.slice(-learning.windowSize);
      const stats = computeAllowance(trimmedWindow.map((w) => w.diffKg), learning);
      t.set(ref, {
        key,
        signature,
        boxId: key.endsWith('|*') ? null : boxId || null,
        window: trimmedWindow,
        samples: trimmedWindow.length,
        allowanceKg: stats.allowanceKg,
        medianKg: stats.medianKg,
        trimmed: stats.trimmed,
        overrideKg: prev.overrideKg ?? null,
        overrideBy: prev.overrideBy ?? null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    })));
    invalidate();
  } catch (err) {
    log.warn('packing_stats.record_failed', { orderId, err });
  }
}

/** Admin list of learned values (for inspection / override). */
async function listStats() {
  const snap = await db.collection(COLLECTION).limit(MAX_DOCS).get();
  return snap.docs.map((d) => {
    const s = d.data();
    return {
      id: d.id,
      key: s.key,
      signature: s.signature,
      boxId: s.boxId || null,
      samples: s.samples || 0,
      allowanceKg: s.allowanceKg || 0,
      medianKg: s.medianKg || 0,
      trimmed: s.trimmed || 0,
      overrideKg: s.overrideKg ?? null,
      overrideBy: s.overrideBy ?? null,
    };
  }).sort((a, b) => b.samples - a.samples);
}

/** Pin (number, kg) or clear (null) an admin override. */
async function setOverride(id, overrideKg, { by } = {}) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) {
    throw Object.assign(new Error('Unknown learned allowance'), { code: 'BAD_PACKAGE' });
  }
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw Object.assign(new Error('Unknown learned allowance'), { code: 'BAD_PACKAGE' });
  let value = null;
  if (overrideKg !== null && overrideKg !== '' && overrideKg !== undefined) {
    value = Number(overrideKg);
    if (!Number.isFinite(value) || value < 0 || value > 5) {
      throw Object.assign(new Error('Override must be between 0 and 5 kg (or empty to clear)'), { code: 'BAD_PACKAGE' });
    }
    value = round3(value);
  }
  await ref.update({ overrideKg: value, overrideBy: value == null ? null : by || null });
  invalidate();
  return { id, overrideKg: value };
}

module.exports = {
  COLLECTION,
  computeAllowance,
  getLearnedMap,
  recordSample,
  listStats,
  setOverride,
  invalidate,
  docId,
};
