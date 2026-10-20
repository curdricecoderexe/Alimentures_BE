/**
 * deliveryService.js — the single source of truth for delivery availability
 * and delivery-fee resolution.
 *
 * Priority (spec §8):
 *   1. PIN-code-specific fastest configuration
 *   2. PIN-code-specific standard configuration
 *   3. Global fastest configuration
 *   4. Global / default standard configuration
 *   5. No applicable rule  →  delivery unavailable
 *
 * `resolveDeliveryOptions()` is what the customer-facing "options" endpoint and
 * the checkout preview call. `computeDeliveryFee()` is the AUTHORITATIVE
 * resolver used at order creation — the client fee is never trusted.
 */
'use strict';

const db = require('../config/firebase');
const log = require('../lib/logger');
const shiprocket = require('./shiprocketService');
const {
  DEFAULT_SETTINGS, SETTINGS_COLLECTION, SETTINGS_DOC, PINCODE_COLLECTION,
  PINCODE_RE, FEE_MIN, FEE_MAX,
} = require('../config/deliveryConstants');

/* ── global settings (short-lived in-process cache) ─────────────────────── */

let _cache = { at: 0, value: null };
const SETTINGS_TTL_MS = 60 * 1000;

/**
 * A PIN rule's standard fee mode. Rules saved before `standardFeeType` existed
 * stored a blank fee as 0 (shown as "Default" in admin), so treat 0 as default.
 */
function standardFeeTypeOf(rule) {
  if (rule.standardFeeType === 'default' || rule.standardFeeType === 'custom') return rule.standardFeeType;
  return Number(rule.standardDeliveryFee) > 0 ? 'custom' : 'default';
}

function clampFee(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(FEE_MAX, Math.max(FEE_MIN, Math.round(v)));
}

/** Coerce a value to a boolean, treating the strings 'false'/'0'/'' as false. */
function toBool(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return !['false', '0', '', 'no', 'off'].includes(v.trim().toLowerCase());
  return !!v;
}

/** Merge a saved settings doc over the defaults; coerce/clamp every value. */
function normaliseSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    defaultDeliveryFee: clampFee(raw.defaultDeliveryFee, d.defaultDeliveryFee),
    defaultStandardEta: String(raw.defaultStandardEta || d.defaultStandardEta).slice(0, 60),
    freeDeliveryEnabled: toBool(raw.freeDeliveryEnabled, d.freeDeliveryEnabled),
    freeDeliveryThreshold: clampFee(raw.freeDeliveryThreshold, d.freeDeliveryThreshold),
    fastestDeliveryEnabled: toBool(raw.fastestDeliveryEnabled, d.fastestDeliveryEnabled),
    defaultFastestDeliveryFee: clampFee(raw.defaultFastestDeliveryFee, d.defaultFastestDeliveryFee),
    defaultFastestEta: String(raw.defaultFastestEta || d.defaultFastestEta).slice(0, 60),
    fastestCutoffTime: String(raw.fastestCutoffTime || d.fastestCutoffTime).slice(0, 30),
    fastestMinOrderValue: clampFee(raw.fastestMinOrderValue, d.fastestMinOrderValue),
    fastestMaxOrderValue: clampFee(raw.fastestMaxOrderValue, d.fastestMaxOrderValue),
    serviceByDefault: toBool(raw.serviceByDefault, d.serviceByDefault),
    updatedAt: raw.updatedAt || null,
    updatedBy: raw.updatedBy || null,
  };
}

async function getGlobalSettings({ fresh = false } = {}) {
  if (!fresh && _cache.value && Date.now() - _cache.at < SETTINGS_TTL_MS) return _cache.value;
  let raw = {};
  try {
    const doc = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
    if (doc.exists) raw = doc.data();
  } catch (err) {
    log.warn('delivery.settings_read_failed', { err });
  }
  const value = normaliseSettings(raw);
  _cache = { at: Date.now(), value };
  return value;
}

function invalidateSettingsCache() {
  _cache = { at: 0, value: null };
}

/* ── pincode lookup ────────────────────────────────────────────────────── */

const normalisePincode = (p) => String(p == null ? '' : p).trim();
const isValidPincode = (p) => PINCODE_RE.test(normalisePincode(p));

async function getPincodeRule(pincode) {
  const pin = normalisePincode(pincode);
  if (!isValidPincode(pin)) return null;
  try {
    const doc = await db.collection(PINCODE_COLLECTION).doc(pin).get();
    if (!doc.exists) return null;
    const d = doc.data();
    if (d.isActive === false) return null; // deactivated rules are ignored
    return { id: doc.id, ...d };
  } catch (err) {
    log.warn('delivery.pincode_read_failed', { pincode: pin, err });
    return null;
  }
}

/* ── Shiprocket courier serviceability (short-lived in-process cache) ───── */

const _serviceCache = new Map();
const SERVICE_TTL_MS = 6 * 60 * 60 * 1000;
const SERVICE_CACHE_MAX = 5000;

/**
 * Can a Shiprocket courier deliver to this PIN?
 * @returns {Promise<{ serviceable: boolean, eta: string|null }|null>} null = unknown
 *   (Shiprocket disabled or unreachable) — callers then fall back to the admin config.
 */
async function getCourierServiceability(pincode) {
  if (!shiprocket.isEnabled()) return null;
  const hit = _serviceCache.get(pincode);
  if (hit && Date.now() - hit.at < SERVICE_TTL_MS) return hit.value;
  try {
    const r = await shiprocket.checkServiceability({ deliveryPincode: pincode });
    let eta = null;
    if (r.serviceable) {
      const rec = r.couriers.find((c) => c.courierId === r.recommendedId) || r.couriers[0];
      // Courier transit days + our 1–2 working-day dispatch window (see Shipping Policy).
      if (rec?.estimatedDays) eta = `${rec.estimatedDays + 1}–${rec.estimatedDays + 2} business days`;
    }
    const value = { serviceable: r.serviceable, eta };
    if (_serviceCache.size >= SERVICE_CACHE_MAX) _serviceCache.delete(_serviceCache.keys().next().value);
    _serviceCache.set(pincode, { at: Date.now(), value });
    return value;
  } catch (err) {
    log.warn('delivery.shiprocket_serviceability_failed', { pincode, err });
    return null; // fail open — an outage must not block checkout
  }
}

/* ── the resolver ──────────────────────────────────────────────────────── */

/**
 * @param {{ pincode?: string, subtotal?: number }} input
 * @returns {Promise<{
 *   pincode: string|null,
 *   pincodeKnown: boolean,
 *   city: string|null,
 *   state: string|null,
 *   deliveryAvailable: boolean,
 *   reason: string|null,
 *   standard: { available: boolean, fee: number, eta: string },
 *   fastest:  { available: boolean, fee: number, eta: string, reason: string|null },
 *   freeDeliveryApplied: boolean,
 * }>}
 */
async function resolveDeliveryOptions({ pincode, subtotal = 0 } = {}) {
  const pin = normalisePincode(pincode);
  const sub = Math.max(0, Number(subtotal) || 0);
  const settings = await getGlobalSettings();

  const out = {
    pincode: isValidPincode(pin) ? pin : null,
    pincodeKnown: false,
    city: null,
    state: null,
    deliveryAvailable: false,
    reason: null,
    standard: { available: false, fee: 0, eta: settings.defaultStandardEta },
    fastest: { available: false, fee: 0, eta: settings.defaultFastestEta, reason: null },
    freeDeliveryApplied: false,
    cutoffTime: settings.fastestCutoffTime || null,
  };

  if (pin && !isValidPincode(pin)) {
    out.reason = 'Invalid PIN code';
    return out;
  }

  const rule = pin ? await getPincodeRule(pin) : null;

  // ── standard ──
  if (rule) {
    out.pincodeKnown = true;
    out.city = rule.city || null;
    out.state = rule.state || null;
    if (rule.deliveryAvailable === false) {
      out.reason = 'We do not deliver to this PIN code yet.';
      return out;
    }
    out.standard.available = true;
    out.standard.fee = standardFeeTypeOf(rule) === 'custom'
      ? clampFee(rule.standardDeliveryFee, settings.defaultDeliveryFee)
      : settings.defaultDeliveryFee;
    if (rule.standardDeliveryEta) out.standard.eta = String(rule.standardDeliveryEta).slice(0, 60);
  } else if (settings.serviceByDefault) {
    // No admin rule for this PIN → ask our courier partner (Shiprocket) whether it
    // is serviceable. An explicit admin PIN rule always takes precedence.
    const courier = pin ? await getCourierServiceability(pin) : null;
    if (courier && !courier.serviceable) {
      out.reason = 'Our courier partners do not deliver to this PIN code yet.';
      return out;
    }
    out.standard.available = true;
    out.standard.fee = settings.defaultDeliveryFee;
    if (courier?.eta) out.standard.eta = courier.eta;
  } else {
    out.reason = 'Delivery is currently unavailable for this PIN code.';
    return out;
  }

  // ── free-delivery override (standard only) ──
  if (settings.freeDeliveryEnabled && sub >= settings.freeDeliveryThreshold && sub > 0) {
    out.standard.fee = 0;
    out.freeDeliveryApplied = true;
  }

  // ── fastest ──
  const fastestGloballyOn = !!settings.fastestDeliveryEnabled;
  const fastestForPin = rule
    ? rule.fastestDeliveryAvailable === true
    : settings.serviceByDefault; // no rule → allowed if globally on and serviced by default

  if (fastestGloballyOn && fastestForPin) {
    let fee = clampFee(
      rule && rule.fastestDeliveryFee != null ? rule.fastestDeliveryFee : settings.defaultFastestDeliveryFee,
      settings.defaultFastestDeliveryFee,
    );
    let available = true;
    let reason = null;

    if (settings.fastestMinOrderValue > 0 && sub > 0 && sub < settings.fastestMinOrderValue) {
      available = false;
      reason = `Fastest delivery needs a minimum order of ₹${settings.fastestMinOrderValue}.`;
    }
    if (available && settings.fastestMaxOrderValue > 0 && sub > settings.fastestMaxOrderValue) {
      available = false;
      reason = `Fastest delivery is not available above ₹${settings.fastestMaxOrderValue}.`;
    }

    out.fastest = {
      available,
      fee,
      eta: (rule && rule.fastestDeliveryEta) ? String(rule.fastestDeliveryEta).slice(0, 60) : settings.defaultFastestEta,
      reason,
    };
  }

  out.deliveryAvailable = out.standard.available;
  return out;
}

/* ── authoritative fee for order creation ──────────────────────────────── */

class DeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.status = 400;
    this.publicMessage = message;
  }
}

/**
 * The ONLY function that decides what a customer is charged for delivery.
 * @returns {Promise<{ fee:number, method:'standard'|'fastest', eta:string, freeDeliveryApplied:boolean }>}
 * @throws DeliveryError('DELIVERY_UNAVAILABLE' | 'FASTEST_UNAVAILABLE' | 'INVALID_PINCODE')
 */
async function computeDeliveryFee({ pincode, method = 'standard', subtotal = 0 } = {}) {
  const wanted = method === 'fastest' ? 'fastest' : 'standard';
  const opts = await resolveDeliveryOptions({ pincode, subtotal });

  if (!opts.deliveryAvailable) {
    throw new DeliveryError('DELIVERY_UNAVAILABLE', opts.reason || 'Delivery is unavailable for this PIN code.');
  }

  if (wanted === 'fastest') {
    if (!opts.fastest.available) {
      throw new DeliveryError('FASTEST_UNAVAILABLE', opts.fastest.reason || 'Fastest delivery is not available for this order.');
    }
    return { fee: opts.fastest.fee, method: 'fastest', eta: opts.fastest.eta, freeDeliveryApplied: false };
  }

  return {
    fee: opts.standard.fee,
    method: 'standard',
    eta: opts.standard.eta,
    freeDeliveryApplied: opts.freeDeliveryApplied,
  };
}

module.exports = {
  getGlobalSettings,
  normaliseSettings,
  invalidateSettingsCache,
  getPincodeRule,
  resolveDeliveryOptions,
  computeDeliveryFee,
  isValidPincode,
  normalisePincode,
  clampFee,
  standardFeeTypeOf,
  DeliveryError,
};
