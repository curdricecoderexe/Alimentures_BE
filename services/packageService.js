/**
 * packageService.js — parcel size + weight for Shiprocket.
 *
 * Couriers bill MAX(dead weight, volumetric weight), where
 *   volumetric kg = L × B × H (cm) / divisor (5000 for most domestic couriers,
 *   configurable as `volumetricDivisor`).
 *
 *   1. Admin keeps a PACKAGING CATALOGUE (Admin → Shipping & Boxes), stored in
 *      `shippingSettings/packaging`: cardboard boxes, courier flyers and covers,
 *      each with its EXTERNAL size, tare weight, filler weight, weight limit,
 *      material cost and (optionally) the product categories it may carry.
 *   2. Each product variant may carry its PACKED weight (`shipWeightKg`) and
 *      packed size (`dims: { l, b, h }` in cm). Orders snapshot both.
 *   3. buildPackage() evaluates EVERY active package that safely fits the
 *      contents and estimates its dead weight:
 *        contents + inner packaging (per item, by category) + tare + filler
 *        + tape/invoice + learned allowance (historical packing data)
 *        + safety allowance (max(pct of weight, minimum kg))
 *      then volumetric + chargeable weight, and picks the package with the
 *      lowest expected cost (courier freight for its chargeable weight when a
 *      rate lookup is available, else the billing slab) + material cost.
 *   4. Every estimate carries a confidence level. Missing item dimensions use
 *      an explicitly configured fallback size, or the box is chosen by weight
 *      only — never silently treated as accurate (confidence 'low').
 *
 * Every number has a sane fallback so an empty catalogue / unconfigured product
 * still produces a valid Shiprocket payload (the legacy env box).
 */
'use strict';

const db = require('../config/firebase');
const log = require('../lib/logger');

const SETTINGS_COLLECTION = 'shippingSettings';
const SETTINGS_DOC = 'packaging';

const LIMITS = Object.freeze({
  DIM_MIN: 0.5, DIM_MAX: 300, // cm
  WEIGHT_MIN: 0.005, WEIGHT_MAX: 100, // kg (box/item)
  PARCEL_MIN_KG: 0.1,
  MAX_BOXES: 30,
  MAX_CATEGORY_RULES: 50,
  MATERIAL_COST_MAX: 1000, // ₹ per package
});

/** cardboard box | courier flyer (poly mailer) | padded/bubble cover */
const PACKAGE_TYPES = Object.freeze(['box', 'flyer', 'cover']);
/** Package types that give no crush protection (jars / glass need a box). */
const SOFT_TYPES = Object.freeze(['flyer', 'cover']);
const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
const ESTIMATE_VERSION = 2;

/**
 * Starter catalogue — single item up to bulk, smallest first; admin edits these.
 * Sizes are EXTERNAL (what the courier measures). maxWeightKg includes the box.
 *   box      size (cm)   volumetric   typical contents
 *   XS       12×10×6     0.14 kg      one 100–250 g pouch / jar
 *   S        15×12×8     0.29 kg      1–2 small packs (≤ 0.5 kg)
 *   M        22×16×10    0.70 kg      2–3 packs (≤ 1.5 kg)
 *   L        30×22×14    1.85 kg      4–6 packs (≤ 3.5 kg)
 *   XL       36×28×18    3.63 kg      family order (≤ 7 kg)
 *   XXL      40×30×25    6.00 kg      large order (≤ 12 kg)
 *   C20      45×35×30    9.45 kg      bulk (≤ 20 kg)
 *   C30      55×40×35    15.4 kg      bulk (≤ 30 kg)
 * Flyers ship flat pouches with almost no volumetric penalty; they start
 * INACTIVE — switch them on once you stock them.
 */
const DEFAULT_BOXES = Object.freeze([
  { id: 'BX-XS', name: 'Extra small', type: 'box', length: 12, breadth: 10, height: 6, boxWeightKg: 0.04, maxWeightKg: 0.35, isActive: true },
  { id: 'BX-S', name: 'Small', type: 'box', length: 15, breadth: 12, height: 8, boxWeightKg: 0.06, maxWeightKg: 0.6, isActive: true },
  { id: 'BX-M', name: 'Medium', type: 'box', length: 22, breadth: 16, height: 10, boxWeightKg: 0.11, maxWeightKg: 1.5, isActive: true },
  { id: 'BX-L', name: 'Large', type: 'box', length: 30, breadth: 22, height: 14, boxWeightKg: 0.18, maxWeightKg: 3.5, isActive: true },
  { id: 'BX-XL', name: 'Extra large', type: 'box', length: 36, breadth: 28, height: 18, boxWeightKg: 0.26, maxWeightKg: 7, isActive: true },
  { id: 'BX-XXL', name: 'Double extra large', type: 'box', length: 40, breadth: 30, height: 25, boxWeightKg: 0.4, maxWeightKg: 12, isActive: true },
  // Bulk orders ship as ONE big carton. Orders that don't fit the largest active
  // box are refused at checkout (see OVERSIZE_MESSAGE) — add bigger cartons here.
  { id: 'BX-C20', name: 'Bulk carton', type: 'box', length: 45, breadth: 35, height: 30, boxWeightKg: 0.6, maxWeightKg: 20, isActive: true },
  { id: 'BX-C30', name: 'Bulk carton large', type: 'box', length: 55, breadth: 40, height: 35, boxWeightKg: 0.8, maxWeightKg: 30, isActive: true },
  { id: 'FL-S', name: 'Flyer small', type: 'flyer', length: 25, breadth: 20, height: 4, boxWeightKg: 0.01, maxWeightKg: 1, isActive: false },
  { id: 'FL-M', name: 'Flyer medium', type: 'flyer', length: 32, breadth: 25, height: 6, boxWeightKg: 0.015, maxWeightKg: 2, isActive: false },
]);

const OVERSIZE_MESSAGE = 'This order is too large to ship as one parcel. Please reduce the quantity or contact us for a bulk order quote.';

const envNum = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

function defaultSettings() {
  return {
    boxes: DEFAULT_BOXES.map((b) => ({ ...b, fillerKg: 0, materialCost: 0, allowedCategories: [] })),
    autoSelectBox: true,
    fillFactor: 1.15, // ×1.15 item volume for filler / air gaps
    extraPackagingKg: 0.02, // tape, invoice, label
    pouchAllowancePct: 5, // added to a label weight ("500g") when a variant has no packed weight
    volumetricDivisor: 5000,
    billingSlabKg: 0.5, // couriers bill in 0.5 kg steps
    defaultItemWeightKg: envNum('SHIPROCKET_DEFAULT_ITEM_WEIGHT_KG', 0.5),
    // Inner packaging per unit (bubble wrap, sleeve, inner pouch), by category.
    innerPackagingKg: 0, // default for any category not listed
    categoryInnerPackagingKg: {}, // e.g. { Honey: 0.04 }
    // Categories that must never go in a flyer / cover (jars, glass, crushable).
    boxOnlyCategories: [],
    // Safety allowance on the estimated dead weight: max(pct × weight, minimum).
    safetyPct: 3,
    safetyMinKg: 0.01,
    // Packed size used for items WITHOUT dimensions. null = no fallback: the box
    // is then chosen by weight only. Either way the estimate is flagged 'low'.
    fallbackItemDims: null, // e.g. { l: 15, b: 10, h: 5 }
    categoryFallbackDims: {}, // e.g. { Cookies: { l: 18, b: 12, h: 5 } }
    // Historical learning (see packingStatsService).
    learning: { enabled: true, minSamples: 5, percentile: 75, maxAllowanceKg: 0.3, windowSize: 50 },
    // Dispatch: staff must measure the packed parcel before courier booking.
    requirePackingVerification: true,
    // Freight difference (₹, actual courier − checkout quote) policy at dispatch.
    // The customer is NEVER charged more after payment.
    adjustment: { absorbUpToRs: 10, autoDispatchUpToRs: 25 },
    // Used only when no box is active (legacy behaviour).
    fallbackBox: {
      length: envNum('SHIPROCKET_PKG_LENGTH_CM', 20),
      breadth: envNum('SHIPROCKET_PKG_BREADTH_CM', 15),
      height: envNum('SHIPROCKET_PKG_HEIGHT_CM', 10),
    },
  };
}

/* ── small validators ──────────────────────────────────────────────────── */

const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;
const ceil2 = (n) => Math.ceil(n * 100 - 1e-9) / 100;
const inRange = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;

function num(v, { min, max, fallback = null } = {}) {
  if (v === '' || v == null) return fallback;
  const n = Number(v);
  return inRange(n, min, max) ? n : fallback;
}

/** { l, b, h } in cm, or null when any side is missing/invalid. */
function parseDims(d) {
  if (!d || typeof d !== 'object') return null;
  const l = num(d.l ?? d.length, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  const b = num(d.b ?? d.breadth, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  const h = num(d.h ?? d.height, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  return l && b && h ? { l: round2(l), b: round2(b), h: round2(h) } : null;
}

/** "500g" → 0.5, "1kg" → 1, "1.5 KG" → 1.5; anything else → null. */
function parseWeightKg(label) {
  const m = String(label || '').trim().toLowerCase().match(/^([\d.]+)\s*(kg|kgs|g|gm|gms|gram|grams)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].startsWith('k') ? n : n / 1000;
}

const catKey = (c) => String(c || '').trim().toLowerCase();
const cleanCategory = (c) => String(c || '').trim().slice(0, 60);

/** Category-keyed kg map (inner packaging), validated. */
function normaliseKgMap(raw, { strict, label, max = 5 }) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.entries(raw).slice(0, LIMITS.MAX_CATEGORY_RULES).forEach(([k, v]) => {
    const key = cleanCategory(k);
    if (!key) return;
    const n = num(v, { min: 0, max });
    if (n == null) {
      if (strict) throw badInput(`${label} for "${key}" must be between 0 and ${max} kg`);
      return;
    }
    out[key] = round3(n);
  });
  return out;
}

function normaliseDimsMap(raw, { strict }) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.entries(raw).slice(0, LIMITS.MAX_CATEGORY_RULES).forEach(([k, v]) => {
    const key = cleanCategory(k);
    if (!key) return;
    const d = parseDims(v);
    if (!d) {
      if (strict) throw badInput(`Fallback size for "${key}" needs L, B and H between 0.5 and 300 cm`);
      return;
    }
    out[key] = d;
  });
  return out;
}

const normaliseCategoryList = (raw) => (Array.isArray(raw)
  ? [...new Set(raw.map(cleanCategory).filter(Boolean))].slice(0, LIMITS.MAX_CATEGORY_RULES)
  : []);

/** Case-insensitive lookup in a category-keyed map. */
function byCategory(map, category) {
  if (!map) return undefined;
  const k = catKey(category);
  const hit = Object.keys(map).find((key) => catKey(key) === k);
  return hit === undefined ? undefined : map[hit];
}

/* ── variant shipping fields (product create/update) ───────────────────── */

/**
 * Validate a variant's optional shipping fields.
 * @returns {string|null} error message
 */
function validateVariantShipping(v = {}) {
  const label = v.weight || 'a variant';
  if (v.shipWeightKg != null && v.shipWeightKg !== '') {
    const w = Number(v.shipWeightKg);
    if (!inRange(w, LIMITS.WEIGHT_MIN, LIMITS.WEIGHT_MAX)) return `Packed weight for ${label} must be between 0.005 and 100 kg`;
  }
  const d = v.dims;
  if (d && typeof d === 'object') {
    const sides = [d.l, d.b, d.h].filter((x) => x !== '' && x != null);
    if (sides.length && sides.length < 3) return `Enter all three packed dimensions (L × B × H) for ${label}, or leave them all empty`;
    if (sides.length === 3 && !parseDims(d)) return `Packed dimensions for ${label} must be between 0.5 and 300 cm`;
  }
  return null;
}

/** Strip/normalise a variant's shipping fields in place-safe fashion. */
function normaliseVariantShipping(v = {}) {
  const out = { ...v };
  const w = num(v.shipWeightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX });
  if (w) out.shipWeightKg = round2(w * 1000) / 1000; else delete out.shipWeightKg;
  const dims = parseDims(v.dims);
  if (dims) out.dims = dims; else delete out.dims;
  return out;
}

/** Shipping snapshot for an order item, from its product variant. */
function variantShipping(variant = {}) {
  const out = {};
  const w = num(variant.shipWeightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX });
  if (w) out.shipWeightKg = w;
  const dims = parseDims(variant.dims);
  if (dims) out.dims = dims;
  if (variant.requiresBox === true) out.requiresBox = true;
  return out;
}

/* ── settings ──────────────────────────────────────────────────────────── */

const badInput = (message) => Object.assign(new Error(message), { code: 'BAD_PACKAGE' });

function normaliseBox(raw = {}, i = 0, { strict = false } = {}) {
  const id = String(raw.id || raw.code || `BOX-${i + 1}`).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
  const length = num(raw.length, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  const breadth = num(raw.breadth, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  const height = num(raw.height, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  if (!id || !length || !breadth || !height) return null;
  const type = raw.type == null || raw.type === '' ? 'box' : String(raw.type).toLowerCase();
  if (!PACKAGE_TYPES.includes(type)) {
    if (strict) throw badInput(`Package ${id}: type must be one of ${PACKAGE_TYPES.join(', ')}`);
    return null;
  }
  const materialCost = num(raw.materialCost, { min: 0, max: LIMITS.MATERIAL_COST_MAX, fallback: null });
  if (strict && raw.materialCost !== '' && raw.materialCost != null && materialCost == null) {
    throw badInput(`Package ${id}: material cost must be between ₹0 and ₹${LIMITS.MATERIAL_COST_MAX}`);
  }
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 40),
    type,
    length: round2(length),
    breadth: round2(breadth),
    height: round2(height),
    boxWeightKg: round3(num(raw.boxWeightKg, { min: 0, max: 20, fallback: 0 })), // tare
    fillerKg: round3(num(raw.fillerKg, { min: 0, max: 5, fallback: 0 })), // void fill / protection
    maxWeightKg: num(raw.maxWeightKg, { min: 0, max: LIMITS.WEIGHT_MAX, fallback: 0 }), // 0 = no limit
    materialCost: round2(materialCost ?? 0),
    allowedCategories: normaliseCategoryList(raw.allowedCategories), // [] = any
    isActive: raw.isActive !== false,
  };
}

function normaliseLearning(raw = {}, d) {
  return {
    enabled: raw.enabled == null ? d.enabled : raw.enabled !== false,
    minSamples: Math.round(num(raw.minSamples, { min: 1, max: 1000, fallback: d.minSamples })),
    percentile: num(raw.percentile, { min: 50, max: 95, fallback: d.percentile }),
    maxAllowanceKg: num(raw.maxAllowanceKg, { min: 0, max: 5, fallback: d.maxAllowanceKg }),
    windowSize: Math.round(num(raw.windowSize, { min: 5, max: 500, fallback: d.windowSize })),
  };
}

/**
 * Merge a saved settings doc over defaults. With `strict`, throw a
 * user-facing Error on bad input instead of silently dropping it.
 */
function normaliseSettings(raw = {}, { strict = false } = {}) {
  const d = defaultSettings();
  let boxes = d.boxes;
  if (Array.isArray(raw.boxes)) {
    if (raw.boxes.length > LIMITS.MAX_BOXES) {
      if (strict) throw badInput(`At most ${LIMITS.MAX_BOXES} packages are allowed`);
    }
    boxes = [];
    const seen = new Set();
    raw.boxes.slice(0, LIMITS.MAX_BOXES).forEach((b, i) => {
      const box = normaliseBox(b, i, { strict });
      if (!box) {
        if (strict) throw badInput(`Package ${i + 1}: code and all three sides (0.5–300 cm) are required`);
        return;
      }
      if (seen.has(box.id)) {
        if (strict) throw badInput(`Package code "${box.id}" is used twice`);
        return;
      }
      seen.add(box.id);
      boxes.push(box);
    });
  }
  const fallbackItemDims = raw.fallbackItemDims == null || raw.fallbackItemDims === '' ? null : parseDims(raw.fallbackItemDims);
  if (strict && raw.fallbackItemDims && !fallbackItemDims) {
    throw badInput('Fallback item size needs L, B and H between 0.5 and 300 cm (or leave it empty)');
  }
  return {
    boxes,
    autoSelectBox: raw.autoSelectBox == null ? d.autoSelectBox : raw.autoSelectBox !== false,
    fillFactor: num(raw.fillFactor, { min: 1, max: 2, fallback: d.fillFactor }),
    extraPackagingKg: num(raw.extraPackagingKg, { min: 0, max: 5, fallback: d.extraPackagingKg }),
    pouchAllowancePct: num(raw.pouchAllowancePct, { min: 0, max: 100, fallback: d.pouchAllowancePct }),
    volumetricDivisor: num(raw.volumetricDivisor, { min: 1000, max: 10000, fallback: d.volumetricDivisor }),
    billingSlabKg: num(raw.billingSlabKg, { min: 0.1, max: 5, fallback: d.billingSlabKg }),
    defaultItemWeightKg: num(raw.defaultItemWeightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX, fallback: d.defaultItemWeightKg }),
    innerPackagingKg: num(raw.innerPackagingKg, { min: 0, max: 5, fallback: d.innerPackagingKg }),
    categoryInnerPackagingKg: normaliseKgMap(raw.categoryInnerPackagingKg, { strict, label: 'Inner packaging' }),
    boxOnlyCategories: normaliseCategoryList(raw.boxOnlyCategories),
    safetyPct: num(raw.safetyPct, { min: 0, max: 50, fallback: d.safetyPct }),
    safetyMinKg: num(raw.safetyMinKg, { min: 0, max: 2, fallback: d.safetyMinKg }),
    fallbackItemDims,
    categoryFallbackDims: normaliseDimsMap(raw.categoryFallbackDims, { strict }),
    learning: normaliseLearning(raw.learning || {}, d.learning),
    adjustment: {
      absorbUpToRs: num(raw.adjustment?.absorbUpToRs, { min: 0, max: 5000, fallback: d.adjustment.absorbUpToRs }),
      autoDispatchUpToRs: Math.max(
        num(raw.adjustment?.absorbUpToRs, { min: 0, max: 5000, fallback: d.adjustment.absorbUpToRs }),
        num(raw.adjustment?.autoDispatchUpToRs, { min: 0, max: 5000, fallback: d.adjustment.autoDispatchUpToRs }),
      ),
    },
    requirePackingVerification: raw.requirePackingVerification == null
      ? d.requirePackingVerification
      : raw.requirePackingVerification !== false,
    fallbackBox: d.fallbackBox,
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null,
  };
}

let _cache = { at: 0, value: null };
const TTL_MS = 60 * 1000;

async function getPackagingSettings({ fresh = false } = {}) {
  if (!fresh && _cache.value && Date.now() - _cache.at < TTL_MS) return _cache.value;
  let raw = {};
  try {
    const doc = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
    if (doc.exists) raw = doc.data();
  } catch (err) {
    log.warn('packaging.settings_read_failed', { err });
  }
  const value = normaliseSettings(raw);
  _cache = { at: Date.now(), value };
  return value;
}

/**
 * Merge a partial save over the stored doc: top-level keys the client didn't
 * send keep their stored value, and each box keeps fields the client didn't
 * send (matched by id) — an older admin screen can't wipe newer settings.
 */
function mergeForSave(stored = {}, input = {}) {
  const out = { ...stored, ...input };
  if (Array.isArray(input.boxes) && Array.isArray(stored.boxes)) {
    const prev = new Map(stored.boxes.map((b) => [String(b.id || '').toUpperCase(), b]));
    out.boxes = input.boxes.map((b) => ({ ...(prev.get(String(b.id || '').trim().toUpperCase()) || {}), ...b }));
  }
  if (input.learning && stored.learning) out.learning = { ...stored.learning, ...input.learning };
  if (input.adjustment && stored.adjustment) out.adjustment = { ...stored.adjustment, ...input.adjustment };
  return out;
}

async function savePackagingSettings(input, { by } = {}) {
  let stored = {};
  try {
    const doc = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
    if (doc.exists) stored = doc.data();
  } catch (err) {
    log.warn('packaging.settings_read_failed', { err });
  }
  const value = normaliseSettings(mergeForSave(stored, input), { strict: true });
  const { fallbackBox, ...toStore } = value;
  toStore.updatedAt = new Date().toISOString();
  toStore.updatedBy = by || null;
  await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).set(toStore);
  _cache = { at: 0, value: null };
  return { ...toStore, fallbackBox };
}

/** Test helper. */
function _resetCacheForTests() { _cache = { at: 0, value: null }; }

/* ── package builder (pure) ────────────────────────────────────────────── */

const sortDesc = (arr) => [...arr].sort((a, b) => b - a);
const boxSides = (bx) => sortDesc([bx.length, bx.breadth, bx.height]);
const boxVolume = (bx) => bx.length * bx.breadth * bx.height;

/** Does a single item (sorted sides) physically fit the box (sorted sides)? */
const itemFits = (itemSides, sides) => itemSides.every((s, i) => s <= sides[i]);

/** Courier billing slab for a chargeable weight. */
const slabOf = (kg, slab = 0.5) => Math.max(slab, Math.ceil((Number(kg) - 1e-9) / slab) * slab);

/**
 * Stable signature of an order's composition for historical learning:
 * sorted distinct categories + total units bucket. Box is added per candidate.
 */
function compositionSignature(items = []) {
  const cats = [...new Set(items.map((it) => catKey(it.category) || 'uncategorised'))].sort();
  const units = items.reduce((s, it) => s + Math.max(1, Number(it.quantity) || 1), 0);
  const bucket = units <= 1 ? '1' : units <= 3 ? '2-3' : units <= 6 ? '4-6' : '7+';
  return `${cats.join('+')}#${bucket}`;
}

/** Learned allowance (kg) for a signature + box, from a { key: stat } map. */
function learnedAllowanceFor(learned, signature, boxId, learning) {
  if (!learned || !learning?.enabled) return { kg: 0, key: null, samples: 0, source: null };
  for (const key of [`${signature}|${boxId || '*'}`, `${signature}|*`]) {
    const st = learned[key];
    if (!st) continue;
    if (st.overrideKg != null && Number.isFinite(Number(st.overrideKg))) {
      return { kg: Math.min(learning.maxAllowanceKg, Math.max(0, Number(st.overrideKg))), key, samples: st.samples || 0, source: 'override' };
    }
    if ((st.samples || 0) >= learning.minSamples && Number.isFinite(Number(st.allowanceKg))) {
      return { kg: Math.min(learning.maxAllowanceKg, Math.max(0, Number(st.allowanceKg))), key, samples: st.samples, source: 'learned' };
    }
  }
  return { kg: 0, key: null, samples: 0, source: null };
}

/**
 * Per-item analysis shared by every package candidate.
 * @returns {{ contentsKg, innerKg, itemVolume, itemSideSets, categories, needsBox,
 *   unknownDims, fallbackDimsUsed, noPackedWeight, defaultWeightUsed, warnings, reasons }}
 */
function analyseItems(items, settings) {
  const a = {
    contentsKg: 0, innerKg: 0, itemVolume: 0, itemSideSets: [], categories: new Set(),
    needsBox: false, unknownDims: 0, fallbackDimsUsed: 0, noPackedWeight: 0, defaultWeightUsed: 0,
    warnings: [], reasons: [],
  };
  const boxOnly = new Set(settings.boxOnlyCategories.map(catKey));
  for (const it of items) {
    const qty = Math.max(1, Number(it.quantity) || 1);
    const category = cleanCategory(it.category);
    if (category) a.categories.add(category);
    if (it.requiresBox === true || (category && boxOnly.has(catKey(category)))) a.needsBox = true;

    let unitKg = num(it.shipWeightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX });
    if (!unitKg) {
      a.noPackedWeight += 1;
      const label = parseWeightKg(it.selectedWeight);
      if (label) unitKg = label * (1 + settings.pouchAllowancePct / 100);
      else { unitKg = settings.defaultItemWeightKg; a.defaultWeightUsed += 1; }
    }
    a.contentsKg += unitKg * qty;
    const inner = byCategory(settings.categoryInnerPackagingKg, category);
    a.innerKg += (inner ?? settings.innerPackagingKg) * qty;

    let dims = parseDims(it.dims);
    if (!dims) {
      const fb = byCategory(settings.categoryFallbackDims, category) || settings.fallbackItemDims;
      if (fb) { dims = fb; a.fallbackDimsUsed += 1; } else a.unknownDims += 1;
    }
    if (dims) {
      a.itemVolume += dims.l * dims.b * dims.h * qty;
      a.itemSideSets.push(sortDesc([dims.l, dims.b, dims.h]));
    }
  }
  if (a.noPackedWeight) a.warnings.push(`${a.noPackedWeight} item(s) have no packed weight — estimated from the label weight`);
  if (a.defaultWeightUsed) a.reasons.push(`${a.defaultWeightUsed} item(s) use the default item weight`);
  if (a.noPackedWeight) a.reasons.push(`${a.noPackedWeight} item(s) without a packed weight`);
  if (a.fallbackDimsUsed) {
    a.warnings.push(`${a.fallbackDimsUsed} item(s) have no packed size — configured fallback size used`);
    a.reasons.push(`${a.fallbackDimsUsed} item(s) sized from the fallback dimensions`);
  }
  if (a.unknownDims) a.reasons.push(`${a.unknownDims} item(s) with unknown dimensions`);
  return a;
}

function confidenceOf(a) {
  if (a.unknownDims || a.fallbackDimsUsed || a.defaultWeightUsed) return 'low';
  if (a.noPackedWeight) return 'medium';
  return 'high';
}

/**
 * Estimate one package candidate.
 * @returns {object} candidate with weights, volumetric, chargeable and fit flags
 */
function estimateCandidate(box, a, settings, { signature, learned, dims: customDims } = {}) {
  const dims = customDims || (box
    ? { l: box.length, b: box.breadth, h: box.height }
    : { l: settings.fallbackBox.length, b: settings.fallbackBox.breadth, h: settings.fallbackBox.height });
  const tareKg = box ? box.boxWeightKg : 0;
  const fillerKg = box ? box.fillerKg || 0 : 0;
  const packingKg = settings.extraPackagingKg;
  const learnedA = learnedAllowanceFor(learned, signature, box?.id, settings.learning);
  const baseKg = a.contentsKg + a.innerKg + tareKg + fillerKg + packingKg + learnedA.kg;
  const safetyKg = Math.max(settings.safetyMinKg, baseKg * (settings.safetyPct / 100));
  const deadKg = Math.max(LIMITS.PARCEL_MIN_KG, ceil2(baseKg + safetyKg));
  const volumetricKg = round2((dims.l * dims.b * dims.h) / settings.volumetricDivisor);
  const chargeableKg = Math.max(deadKg, volumetricKg);

  const sides = sortDesc([dims.l, dims.b, dims.h]);
  const vol = dims.l * dims.b * dims.h;
  const neededVolume = a.itemVolume * settings.fillFactor;
  const type = box?.type || 'box';
  const allowed = box?.allowedCategories?.length ? new Set(box.allowedCategories.map(catKey)) : null;
  const reasons = [];
  if (box?.maxWeightKg && deadKg > box.maxWeightKg) reasons.push('over weight limit');
  if (vol < neededVolume) reasons.push('too little volume');
  if (!a.itemSideSets.every((s) => itemFits(s, sides))) reasons.push('an item is longer than a side');
  if (SOFT_TYPES.includes(type) && a.needsBox) reasons.push('contents need a rigid box');
  // A flyer can't be checked for fit without real item sizes — never assume.
  if (SOFT_TYPES.includes(type) && a.unknownDims) reasons.push('item sizes unknown');
  if (allowed && [...a.categories].some((c) => !allowed.has(catKey(c)))) reasons.push('category not allowed');

  return {
    box,
    dims,
    type,
    deadKg,
    volumetricKg,
    chargeableKg,
    slabKg: slabOf(chargeableKg, settings.billingSlabKg),
    materialCost: box?.materialCost || 0,
    breakdown: {
      contentsKg: round3(a.contentsKg),
      innerKg: round3(a.innerKg),
      tareKg: round3(tareKg),
      fillerKg: round3(fillerKg),
      packingKg: round3(packingKg),
      learnedKg: round3(learnedA.kg),
      safetyKg: round3(safetyKg),
    },
    learned: learnedA.source ? { key: learnedA.key, kg: learnedA.kg, samples: learnedA.samples, source: learnedA.source } : null,
    fits: reasons.length === 0,
    rejectReasons: reasons,
    volume: vol,
  };
}

/** Lowest expected cost first: freight (or slab) + material, then smaller parcel. */
function rankCandidates(cands, rateForKg) {
  const costOf = (c) => {
    const r = rateForKg ? rateForKg(c.chargeableKg) : null;
    return { freight: Number.isFinite(r) && r > 0 ? r : null, c };
  };
  return cands.map(costOf).sort((x, y) => {
    if (x.freight != null && y.freight != null) {
      const d = (x.freight + x.c.materialCost) - (y.freight + y.c.materialCost);
      if (Math.abs(d) > 1e-9) return d;
    } else {
      const d = x.c.slabKg - y.c.slabKg;
      if (Math.abs(d) > 1e-9) return d;
      const m = x.c.materialCost - y.c.materialCost;
      if (Math.abs(m) > 1e-9) return m;
    }
    return x.c.chargeableKg - y.c.chargeableKg || x.c.volume - y.c.volume;
  }).map(({ freight, c }) => ({ ...c, estimatedFreight: freight }));
}

const summariseCandidate = (c) => ({
  boxId: c.box?.id || null,
  boxName: c.box?.name || 'Custom',
  type: c.type,
  length: c.dims.l,
  breadth: c.dims.b,
  height: c.dims.h,
  deadKg: c.deadKg,
  volumetricKg: c.volumetricKg,
  chargeableKg: c.chargeableKg,
  materialCost: c.materialCost,
  estimatedFreight: c.estimatedFreight ?? null,
  fits: c.fits,
  rejectReasons: c.rejectReasons,
});

/**
 * Work out the parcel for a list of order items.
 * @param {Array<{ quantity, selectedWeight?, shipWeightKg?, dims?, category?, requiresBox? }>} items
 * @param {object} settings  normalised packaging settings
 * @param {{ boxId?: string, length?, breadth?, height?, weightKg? }} [override]
 * @param {{ rateForKg?: (kg:number) => number|null, learned?: object }} [opts]
 *   rateForKg — synchronous freight lookup (pre-fetched quotes) used to rank packages
 *   learned   — historical allowances map from packingStatsService
 * @returns {{ boxId, boxName, packageType, length, breadth, height, weightKg, deadKg,
 *   contentsKg, volumetricKg, chargeableKg, materialCost, estimatedFreight, fits,
 *   oversize, source, confidence, confidenceReasons, breakdown, learned, signature,
 *   candidates, warnings: string[], estimateVersion }}
 */
function buildPackage(items = [], settings = normaliseSettings(), override = null, opts = {}) {
  const a = analyseItems(items, settings);
  const warnings = [...a.warnings];
  const signature = compositionSignature(items);
  const ctx = { signature, learned: opts.learned };
  const active = settings.boxes.filter((b) => b.isActive);
  const all = active.map((b) => estimateCandidate(b, a, settings, ctx));
  const fitting = all.filter((c) => c.fits);

  let chosen = null;
  let fits = true;
  let oversize = false; // auto-fit found no package big enough → refuse at checkout
  let source = 'auto';
  let ranked = [];

  const custom = override && parseDims({ l: override.length, b: override.breadth, h: override.height });
  if (custom) {
    source = 'manual';
    chosen = estimateCandidate(null, a, settings, { ...ctx, dims: custom });
    chosen = { ...chosen, fits: true, rejectReasons: [] }; // staff measured it
  } else if (override?.boxId) {
    const box = settings.boxes.find((b) => b.id === String(override.boxId).toUpperCase()) || null;
    if (!box) throw Object.assign(badInput(`Unknown box "${override.boxId}"`), { code: 'BAD_BOX' });
    source = 'manual';
    chosen = estimateCandidate(box, a, settings, ctx);
    fits = chosen.fits;
    if (!fits) warnings.push(`Contents may not fit ${box.name} (${box.id}): ${chosen.rejectReasons.join(', ')}`);
  } else if (active.length && settings.autoSelectBox) {
    ranked = rankCandidates(fitting, opts.rateForKg);
    chosen = ranked[0] || null;
    if (!chosen) {
      // Largest rigid box, flagged — checkout refuses, staff can split or size manually.
      const boxesOnly = all.filter((c) => c.type === 'box').sort((x, y) => x.volume - y.volume);
      chosen = boxesOnly[boxesOnly.length - 1] || all[all.length - 1];
      fits = false;
      oversize = true;
      warnings.push('Contents exceed the largest box — split the order or enter a custom size');
    }
  } else if (active.length) {
    chosen = [...all].sort((x, y) => x.volume - y.volume)[0];
    fits = chosen.fits;
  }

  if (!chosen) {
    chosen = estimateCandidate(null, a, settings, ctx);
    if (!custom) warnings.push('No active boxes configured — using the default parcel size');
  }
  if (a.unknownDims && a.itemSideSets.length === 0 && chosen.box && source === 'auto') {
    warnings.push('No item has packed dimensions — box chosen by weight only');
  } else if (a.unknownDims && source === 'auto') {
    warnings.push(`${a.unknownDims} item(s) have no packed size — their volume is not counted`);
  }

  let weightKg = chosen.deadKg;
  let chargeableKg = chosen.chargeableKg;
  const manualKg = override && num(override.weightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX });
  if (manualKg) {
    weightKg = Math.max(LIMITS.PARCEL_MIN_KG, ceil2(manualKg));
    chargeableKg = Math.max(weightKg, chosen.volumetricKg);
    source = 'manual';
  }

  const confidenceReasons = [...a.reasons];
  if (oversize) confidenceReasons.push('no package fits');
  let confidence = confidenceOf(a);
  if (oversize) confidence = 'low';

  return {
    boxId: chosen.box ? chosen.box.id : null,
    boxName: chosen.box ? chosen.box.name : (custom ? 'Custom' : 'Default'),
    packageType: chosen.type,
    length: chosen.dims.l,
    breadth: chosen.dims.b,
    height: chosen.dims.h,
    weightKg,
    deadKg: weightKg,
    contentsKg: round2(a.contentsKg),
    volumetricKg: chosen.volumetricKg,
    chargeableKg,
    materialCost: chosen.materialCost,
    estimatedFreight: chosen.estimatedFreight ?? null,
    fits,
    oversize,
    source,
    confidence,
    confidenceReasons,
    breakdown: chosen.breakdown,
    learned: chosen.learned,
    signature,
    volumetricDivisor: settings.volumetricDivisor,
    candidates: (ranked.length ? ranked : fitting).slice(0, 4).map(summariseCandidate),
    warnings,
    estimateVersion: ESTIMATE_VERSION,
  };
}

/** Pure maths for a measured parcel (packing verification). */
function measure({ weightKg, length, breadth, height }, settings = normaliseSettings()) {
  const dims = parseDims({ l: length, b: breadth, h: height });
  const w = num(weightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX });
  if (!dims || !w) return null;
  const volumetricKg = round2((dims.l * dims.b * dims.h) / settings.volumetricDivisor);
  const deadKg = round3(w);
  return {
    deadKg,
    length: dims.l,
    breadth: dims.b,
    height: dims.h,
    volumetricKg,
    chargeableKg: Math.max(deadKg, volumetricKg),
    slabKg: slabOf(Math.max(deadKg, volumetricKg), settings.billingSlabKg),
  };
}

/**
 * Parcel for a list of order/cart items. Items without shipping data (orders
 * placed before variants had it, or a raw cart) are enriched from the current
 * product docs.
 * @param {{ rateLookup?: (kg:number) => Promise<number|null>, learned?: object }} [opts]
 *   rateLookup — async freight quote for a chargeable weight (cached by caller).
 *   At most 3 distinct billing slabs among the best-fitting packages are quoted.
 */
async function resolveItemsPackage(rawItems = [], override = null, opts = {}) {
  const settings = await getPackagingSettings();
  const items = rawItems.map((it) => ({ ...it }));
  const missing = items.filter((it) => it.productId && (!it.shipWeightKg && !it.dims || !it.category));
  if (missing.length) {
    try {
      const ids = [...new Set(missing.map((it) => it.productId))];
      const docs = await db.getAll(...ids.map((id) => db.collection('products').doc(id)));
      const byId = new Map(docs.filter((d) => d.exists).map((d) => [d.id, d.data()]));
      for (const it of missing) {
        const p = byId.get(it.productId);
        if (!p) continue;
        if (!it.category && p.category) it.category = p.category;
        if (p.requiresBox === true) it.requiresBox = true;
        if (it.shipWeightKg || it.dims) continue;
        const variants = p.variants || [];
        const v = variants.find((x) => x.weight === it.selectedWeight) || (!it.selectedWeight ? variants[0] : null);
        if (v) Object.assign(it, variantShipping(v));
      }
    } catch (err) {
      log.warn('packaging.enrich_failed', { err });
    }
  }

  let learned = opts.learned;
  if (learned === undefined && settings.learning.enabled) {
    try {
      learned = await require('./packingStatsService').getLearnedMap();
    } catch (err) {
      log.warn('packaging.learned_read_failed', { err });
      learned = null;
    }
  }

  // Price the cheapest few billing slabs when a rate lookup is available.
  let rateForKg;
  if (typeof opts.rateLookup === 'function' && !override) {
    const probe = buildPackage(items, settings, null, { learned });
    const slabs = [...new Set((probe.candidates || []).map((c) => slabOf(c.chargeableKg, settings.billingSlabKg)))].slice(0, 3);
    const rates = new Map();
    await Promise.all(slabs.map(async (s) => {
      try {
        const r = await opts.rateLookup(s);
        if (Number.isFinite(r) && r > 0) rates.set(s, r);
      } catch { /* unpriced slab → ranked by slab */ }
    }));
    if (rates.size === slabs.length && rates.size > 0) {
      rateForKg = (kg) => rates.get(slabOf(kg, settings.billingSlabKg)) ?? null;
    }
  }
  return buildPackage(items, settings, override, { learned, rateForKg });
}

/** Package for a stored order. */
const resolveOrderPackage = (order, override = null, opts = {}) => resolveItemsPackage(order.items || [], override, opts);

/**
 * The parcel a cart will ship in (auto box), for checkout quotes. Never throws
 * — null on failure (callers then use their default slab).
 */
async function quotePackage(items = [], opts = {}) {
  if (!Array.isArray(items) || !items.length) return null;
  try {
    return await resolveItemsPackage(items, null, opts);
  } catch (err) {
    log.warn('packaging.quote_failed', { err });
    return null;
  }
}

/** Courier-billable weight (kg) for a cart, or null. */
async function quoteWeightKg(items = []) {
  return (await quotePackage(items))?.chargeableKg ?? null;
}

/** Compact parcel snapshot stored on an order (`plannedPackage`). */
const packageSnapshot = (pkg) => (pkg ? {
  boxId: pkg.boxId,
  boxName: pkg.boxName,
  packageType: pkg.packageType || 'box',
  length: pkg.length,
  breadth: pkg.breadth,
  height: pkg.height,
  weightKg: pkg.weightKg,
  volumetricKg: pkg.volumetricKg,
  chargeableKg: pkg.chargeableKg,
  materialCost: pkg.materialCost ?? 0,
  confidence: pkg.confidence || null,
  signature: pkg.signature || null,
  breakdown: pkg.breakdown || null,
  estimateVersion: pkg.estimateVersion || 1,
} : null);

/** Validate a staff-supplied override from a request body. */
function parseOverride(body) {
  if (!body || typeof body !== 'object') return null;
  const hasCustom = ['length', 'breadth', 'height'].some((k) => body[k] !== '' && body[k] != null);
  if (hasCustom && !parseDims({ l: body.length, b: body.breadth, h: body.height })) {
    throw badInput('Custom box size needs length, breadth and height between 0.5 and 300 cm');
  }
  if (body.weightKg !== '' && body.weightKg != null && !num(body.weightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX })) {
    throw badInput('Parcel weight must be between 0.005 and 100 kg');
  }
  const out = {};
  if (hasCustom) Object.assign(out, { length: body.length, breadth: body.breadth, height: body.height });
  else if (body.boxId) out.boxId = String(body.boxId).slice(0, 20);
  if (body.weightKg !== '' && body.weightKg != null) out.weightKg = body.weightKg;
  return Object.keys(out).length ? out : null;
}

module.exports = {
  DEFAULT_BOXES,
  OVERSIZE_MESSAGE,
  LIMITS,
  PACKAGE_TYPES,
  CONFIDENCE,
  ESTIMATE_VERSION,
  parseWeightKg,
  parseDims,
  slabOf,
  validateVariantShipping,
  normaliseVariantShipping,
  variantShipping,
  normaliseSettings,
  mergeForSave,
  getPackagingSettings,
  savePackagingSettings,
  compositionSignature,
  learnedAllowanceFor,
  buildPackage,
  measure,
  resolveItemsPackage,
  resolveOrderPackage,
  quotePackage,
  quoteWeightKg,
  packageSnapshot,
  parseOverride,
  _resetCacheForTests,
};
