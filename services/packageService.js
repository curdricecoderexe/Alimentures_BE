/**
 * packageService.js — parcel size + weight for Shiprocket.
 *
 * Couriers bill MAX(dead weight, volumetric weight), where
 *   volumetric kg = L × B × H (cm) / divisor (5000 for most domestic couriers).
 * Declaring one fixed box for every order over-bills small orders and
 * under-declares big ones (→ weight-discrepancy debits). Instead:
 *
 *   1. Admin keeps a BOX CATALOGUE (Admin → Shipping & Boxes), stored in
 *      `shippingSettings/packaging`.
 *   2. Each product variant may carry its PACKED weight (`shipWeightKg`) and
 *      packed size (`dims: { l, b, h }` in cm). Orders snapshot both.
 *   3. buildPackage() picks the smallest active box the contents fit in
 *      (weight limit, total volume × fill factor, longest item side), and adds
 *      the box's own weight. Staff may override the box or enter a custom size.
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
  MAX_BOXES: 20,
});

/** Starter catalogue — common e-commerce corrugated boxes; admin edits these. */
const DEFAULT_BOXES = Object.freeze([
  { id: 'BX-S', name: 'Small', length: 15, breadth: 12, height: 8, boxWeightKg: 0.06, maxWeightKg: 0.6, isActive: true },
  { id: 'BX-M', name: 'Medium', length: 22, breadth: 16, height: 10, boxWeightKg: 0.11, maxWeightKg: 1.5, isActive: true },
  { id: 'BX-L', name: 'Large', length: 30, breadth: 22, height: 14, boxWeightKg: 0.18, maxWeightKg: 3.5, isActive: true },
  { id: 'BX-XL', name: 'Extra large', length: 36, breadth: 28, height: 18, boxWeightKg: 0.26, maxWeightKg: 7, isActive: true },
]);

const envNum = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

function defaultSettings() {
  return {
    boxes: DEFAULT_BOXES.map((b) => ({ ...b })),
    autoSelectBox: true,
    fillFactor: 1.15, // ×1.15 item volume for filler / air gaps
    extraPackagingKg: 0.02, // tape, filler, invoice
    pouchAllowancePct: 5, // added to a label weight ("500g") when a variant has no packed weight
    volumetricDivisor: 5000,
    defaultItemWeightKg: envNum('SHIPROCKET_DEFAULT_ITEM_WEIGHT_KG', 0.5),
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
  return out;
}

/* ── settings ──────────────────────────────────────────────────────────── */

function normaliseBox(raw = {}, i = 0) {
  const id = String(raw.id || raw.code || `BOX-${i + 1}`).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20);
  const length = num(raw.length, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  const breadth = num(raw.breadth, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  const height = num(raw.height, { min: LIMITS.DIM_MIN, max: LIMITS.DIM_MAX });
  if (!id || !length || !breadth || !height) return null;
  return {
    id,
    name: String(raw.name || id).trim().slice(0, 40),
    length: round2(length),
    breadth: round2(breadth),
    height: round2(height),
    boxWeightKg: round2(num(raw.boxWeightKg, { min: 0, max: 20, fallback: 0 }) * 1000) / 1000,
    maxWeightKg: num(raw.maxWeightKg, { min: 0, max: LIMITS.WEIGHT_MAX, fallback: 0 }), // 0 = no limit
    isActive: raw.isActive !== false,
  };
}

/**
 * Merge a saved settings doc over defaults. With `strict`, throw a
 * user-facing Error on bad input instead of silently dropping it.
 */
const badInput = (message) => Object.assign(new Error(message), { code: 'BAD_PACKAGE' });

function normaliseSettings(raw = {}, { strict = false } = {}) {
  const d = defaultSettings();
  let boxes = d.boxes;
  if (Array.isArray(raw.boxes)) {
    if (raw.boxes.length > LIMITS.MAX_BOXES) {
      if (strict) throw badInput(`At most ${LIMITS.MAX_BOXES} boxes are allowed`);
    }
    boxes = [];
    const seen = new Set();
    raw.boxes.slice(0, LIMITS.MAX_BOXES).forEach((b, i) => {
      const box = normaliseBox(b, i);
      if (!box) {
        if (strict) throw badInput(`Box ${i + 1}: code and all three sides (0.5–300 cm) are required`);
        return;
      }
      if (seen.has(box.id)) {
        if (strict) throw badInput(`Box code "${box.id}" is used twice`);
        return;
      }
      seen.add(box.id);
      boxes.push(box);
    });
  }
  return {
    boxes,
    autoSelectBox: raw.autoSelectBox == null ? d.autoSelectBox : raw.autoSelectBox !== false,
    fillFactor: num(raw.fillFactor, { min: 1, max: 2, fallback: d.fillFactor }),
    extraPackagingKg: num(raw.extraPackagingKg, { min: 0, max: 5, fallback: d.extraPackagingKg }),
    pouchAllowancePct: num(raw.pouchAllowancePct, { min: 0, max: 100, fallback: d.pouchAllowancePct }),
    volumetricDivisor: num(raw.volumetricDivisor, { min: 1000, max: 10000, fallback: d.volumetricDivisor }),
    defaultItemWeightKg: num(raw.defaultItemWeightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX, fallback: d.defaultItemWeightKg }),
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

async function savePackagingSettings(input, { by } = {}) {
  const value = normaliseSettings(input, { strict: true });
  const { fallbackBox, ...toStore } = value;
  toStore.updatedAt = new Date().toISOString();
  toStore.updatedBy = by || null;
  await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).set(toStore);
  _cache = { at: 0, value: null };
  return { ...toStore, fallbackBox };
}

/* ── package builder (pure) ────────────────────────────────────────────── */

const sortDesc = (arr) => [...arr].sort((a, b) => b - a);
const boxSides = (bx) => sortDesc([bx.length, bx.breadth, bx.height]);
const boxVolume = (bx) => bx.length * bx.breadth * bx.height;

/** Does a single item (sorted sides) physically fit the box (sorted sides)? */
const itemFits = (itemSides, sides) => itemSides.every((s, i) => s <= sides[i]);

/**
 * Work out the parcel for a list of order items.
 * @param {Array<{ quantity, selectedWeight?, shipWeightKg?, dims? }>} items
 * @param {object} settings  normalised packaging settings
 * @param {{ boxId?: string, length?, breadth?, height?, weightKg? }} [override]
 * @returns {{ boxId, boxName, length, breadth, height, weightKg, contentsKg,
 *   volumetricKg, chargeableKg, fits, source, warnings: string[] }}
 */
function buildPackage(items = [], settings = normaliseSettings(), override = null) {
  const warnings = [];
  let noPackedWeight = 0;
  let noDims = 0;
  let contentsKg = 0;
  let itemVolume = 0;
  const itemSideSets = [];

  for (const it of items) {
    const qty = Math.max(1, Number(it.quantity) || 1);
    let unitKg = num(it.shipWeightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX });
    if (!unitKg) {
      noPackedWeight += 1;
      const label = parseWeightKg(it.selectedWeight);
      unitKg = label ? label * (1 + settings.pouchAllowancePct / 100) : settings.defaultItemWeightKg;
    }
    contentsKg += unitKg * qty;

    const dims = parseDims(it.dims);
    if (dims) {
      itemVolume += dims.l * dims.b * dims.h * qty;
      itemSideSets.push(sortDesc([dims.l, dims.b, dims.h]));
    } else {
      noDims += 1;
    }
  }
  if (noPackedWeight) warnings.push(`${noPackedWeight} item(s) have no packed weight — estimated from the label weight`);

  const packingKg = settings.extraPackagingKg;
  const neededVolume = itemVolume * settings.fillFactor;
  const active = settings.boxes.filter((b) => b.isActive).sort((a, b) => boxVolume(a) - boxVolume(b));

  const fitsBox = (bx) => {
    const sides = boxSides(bx);
    const totalKg = contentsKg + bx.boxWeightKg + packingKg;
    return (!bx.maxWeightKg || totalKg <= bx.maxWeightKg)
      && boxVolume(bx) >= neededVolume
      && itemSideSets.every((s) => itemFits(s, sides));
  };

  let box = null;
  let fits = true;
  let source = 'auto';
  let dims;

  const custom = override && parseDims({ l: override.length, b: override.breadth, h: override.height });
  if (custom) {
    source = 'manual';
    dims = custom;
  } else if (override?.boxId) {
    box = settings.boxes.find((b) => b.id === String(override.boxId).toUpperCase()) || null;
    if (!box) throw Object.assign(badInput(`Unknown box "${override.boxId}"`), { code: 'BAD_BOX' });
    source = 'manual';
    fits = fitsBox(box);
    if (!fits) warnings.push(`Contents may not fit ${box.name} (${box.id})`);
  } else if (active.length && settings.autoSelectBox) {
    box = active.find(fitsBox) || null;
    if (!box) {
      box = active[active.length - 1];
      fits = false;
      warnings.push('Contents exceed the largest box — split the order or enter a custom size');
    }
  } else if (active.length) {
    box = active[0];
    fits = fitsBox(box);
  }

  if (!dims) {
    dims = box
      ? { l: box.length, b: box.breadth, h: box.height }
      : { l: settings.fallbackBox.length, b: settings.fallbackBox.breadth, h: settings.fallbackBox.height };
  }
  if (!box && !custom) warnings.push('No active boxes configured — using the default parcel size');
  if (noDims && itemSideSets.length === 0 && box && source === 'auto') {
    warnings.push('No item has packed dimensions — box chosen by weight only');
  }

  let weightKg = contentsKg + (box ? box.boxWeightKg : 0) + packingKg;
  const manualKg = override && num(override.weightKg, { min: LIMITS.WEIGHT_MIN, max: LIMITS.WEIGHT_MAX });
  if (manualKg) { weightKg = manualKg; source = 'manual'; }
  weightKg = Math.max(LIMITS.PARCEL_MIN_KG, ceil2(weightKg));

  const volumetricKg = round2((dims.l * dims.b * dims.h) / settings.volumetricDivisor);
  return {
    boxId: box ? box.id : null,
    boxName: box ? box.name : (custom ? 'Custom' : 'Default'),
    length: dims.l,
    breadth: dims.b,
    height: dims.h,
    weightKg,
    contentsKg: round2(contentsKg),
    volumetricKg,
    chargeableKg: Math.max(weightKg, volumetricKg),
    fits,
    source,
    warnings,
  };
}

/**
 * Parcel for a list of order/cart items. Items without shipping data (orders
 * placed before variants had it, or a raw cart) are enriched from the current
 * product docs.
 */
async function resolveItemsPackage(rawItems = [], override = null) {
  const settings = await getPackagingSettings();
  const items = rawItems.map((it) => ({ ...it }));
  const missing = items.filter((it) => !it.shipWeightKg && !it.dims && it.productId);
  if (missing.length) {
    try {
      const ids = [...new Set(missing.map((it) => it.productId))];
      const docs = await db.getAll(...ids.map((id) => db.collection('products').doc(id)));
      const byId = new Map(docs.filter((d) => d.exists).map((d) => [d.id, d.data()]));
      for (const it of missing) {
        const variants = byId.get(it.productId)?.variants || [];
        const v = variants.find((x) => x.weight === it.selectedWeight) || (!it.selectedWeight ? variants[0] : null);
        if (v) Object.assign(it, variantShipping(v));
      }
    } catch (err) {
      log.warn('packaging.enrich_failed', { err });
    }
  }
  return buildPackage(items, settings, override);
}

/** Package for a stored order. */
const resolveOrderPackage = (order, override = null) => resolveItemsPackage(order.items || [], override);

/**
 * Courier-billable weight (kg) for a cart, for serviceability / rate checks.
 * Never throws — falls back to null (callers then use their default slab).
 */
async function quoteWeightKg(items = []) {
  if (!Array.isArray(items) || !items.length) return null;
  try {
    return (await resolveItemsPackage(items)).chargeableKg;
  } catch (err) {
    log.warn('packaging.quote_failed', { err });
    return null;
  }
}

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
  LIMITS,
  parseWeightKg,
  parseDims,
  validateVariantShipping,
  normaliseVariantShipping,
  variantShipping,
  normaliseSettings,
  getPackagingSettings,
  savePackagingSettings,
  buildPackage,
  resolveItemsPackage,
  resolveOrderPackage,
  quoteWeightKg,
  parseOverride,
};
