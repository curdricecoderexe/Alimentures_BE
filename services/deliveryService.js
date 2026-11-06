/**
 * deliveryService.js — the single source of truth for delivery availability
 * and delivery-fee resolution.
 *
 * Delivery partner (per PIN rule, default Shiprocket):
 *   - 'local'      → your dedicated partner; Shiprocket is never consulted.
 *   - 'shiprocket' → the live courier check ALWAYS runs (even when an admin rule
 *                    exists), so a PIN no courier serves is blocked before payment.
 *                    The check uses the cart's real parcel weight.
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
  PINCODE_RE, FEE_MIN, FEE_MAX, DELIVERY_PARTNERS, MAX_FEE_BANDS,
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

/**
 * Fee bands keyed on the courier's freight quote: [{ maxRate, fee }], sorted
 * ascending with maxRate 0 ("and above") last. At most MAX_FEE_BANDS bands.
 */
function normaliseFeeBands(raw, fallback) {
  if (!Array.isArray(raw)) return fallback.map((b) => ({ ...b }));
  const bands = raw.slice(0, MAX_FEE_BANDS)
    .map((b) => ({ maxRate: clampFee(b?.maxRate, 0), fee: clampFee(b?.fee, NaN) }))
    .filter((b) => Number.isFinite(b.fee));
  bands.sort((a, b) => (a.maxRate || Infinity) - (b.maxRate || Infinity));
  return bands.length ? bands : fallback.map((b) => ({ ...b }));
}

/** Customer fee for a courier freight quote, or null when no band matches. */
/**
 * Band fee for a freight quote. The customer always pays the delivery cost in
 * full: the result is never below the quote itself (rounded up to the rupee),
 * even if a band is set too low or the quote is above every band.
 */
function feeForCourierRate(rate, bands) {
  if (!(rate > 0) || !Array.isArray(bands)) return null;
  const band = bands.find((b) => !b.maxRate || rate <= b.maxRate);
  return clampFee(Math.max(band ? band.fee : 0, Math.ceil(rate)), null);
}

/**
 * Customer fee from a courier freight quote (bands), or null (→ caller falls
 * back) when there's no quote. Courier-linked 'bands' pricing is always on.
 */
function courierLinkedFeeFor(rate, settings) {
  if (!(rate > 0)) return null;
  return feeForCourierRate(rate, settings.courierFeeBands);
}

/** Cheapest courier in a quote list (ties → faster). */
function pickCheapestCourier(couriers = []) {
  return couriers
    .filter((c) => c.rate > 0)
    .sort((a, b) => a.rate - b.rate || (a.estimatedDays || 99) - (b.estimatedDays || 99))[0] || null;
}

/** Fastest air/express courier: non-surface, fewest days, then cheapest. */
function pickExpressCourier(couriers = []) {
  return couriers
    .filter((c) => !c.isSurface && c.estimatedDays)
    .sort((a, b) => a.estimatedDays - b.estimatedDays || a.rate - b.rate)[0] || null;
}

const partnerOf = (rule) => (rule && DELIVERY_PARTNERS.includes(rule.deliveryPartner) ? rule.deliveryPartner : 'shiprocket');

/** Merge a saved settings doc over the defaults; coerce/clamp every value. */
function normaliseSettings(raw = {}) {
  const d = DEFAULT_SETTINGS;
  return {
    defaultDeliveryFee: clampFee(raw.defaultDeliveryFee, d.defaultDeliveryFee),
    defaultStandardEta: String(raw.defaultStandardEta || d.defaultStandardEta).slice(0, 60),
    // POLICY: delivery is always collected from the customer — no free delivery.
    freeDeliveryEnabled: false,
    freeDeliveryThreshold: clampFee(raw.freeDeliveryThreshold, d.freeDeliveryThreshold),
    fastestDeliveryEnabled: toBool(raw.fastestDeliveryEnabled, d.fastestDeliveryEnabled),
    defaultFastestDeliveryFee: clampFee(raw.defaultFastestDeliveryFee, d.defaultFastestDeliveryFee),
    defaultFastestEta: String(raw.defaultFastestEta || d.defaultFastestEta).slice(0, 60),
    fastestCutoffTime: String(raw.fastestCutoffTime || d.fastestCutoffTime).slice(0, 30),
    fastestMinOrderValue: clampFee(raw.fastestMinOrderValue, d.fastestMinOrderValue),
    fastestMaxOrderValue: clampFee(raw.fastestMaxOrderValue, d.fastestMaxOrderValue),
    serviceByDefault: toBool(raw.serviceByDefault, d.serviceByDefault),
    // POLICY: the fee always follows the courier quote via bands.
    courierLinkedFee: true,
    courierFeeMode: 'bands',
    courierFeeMarkupPct: Math.min(100, Math.max(0, Number.isFinite(Number(raw.courierFeeMarkupPct)) && raw.courierFeeMarkupPct !== ''
      ? Number(raw.courierFeeMarkupPct) : d.courierFeeMarkupPct)),
    courierFeeBands: normaliseFeeBands(raw.courierFeeBands, d.courierFeeBands),
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
const DEFAULT_QUOTE_KG = 0.5;

/** Round up to the courier's 0.5 kg billing slab (also the cache bucket). */
const weightSlab = (kg) => Math.max(0.5, Math.ceil((Number(kg) || DEFAULT_QUOTE_KG) * 2) / 2);

/**
 * Can a Shiprocket courier deliver this parcel weight to this PIN?
 * @returns {Promise<{ serviceable: boolean, eta: string|null, rate: number|null,
 *   express: { eta: string|null, rate: number }|null }|null>}
 *   null = unknown (Shiprocket disabled or unreachable) — callers then fall back
 *   to the admin config. `express` = fastest non-surface (air/express) courier.
 */
async function getCourierServiceability(pincode, weightKg) {
  if (!shiprocket.isEnabled()) return null;
  const slab = weightSlab(weightKg);
  const key = `${pincode}:${slab}`;
  const hit = _serviceCache.get(key);
  if (hit && Date.now() - hit.at < SERVICE_TTL_MS) return hit.value;
  try {
    const r = await shiprocket.checkServiceability({ deliveryPincode: pincode, weightKg: slab });
    // Courier transit days + our 1–2 working-day dispatch window (see Shipping Policy).
    const etaFor = (c) => (c?.estimatedDays ? `${c.estimatedDays + 1}–${c.estimatedDays + 2} business days` : null);
    let value = { serviceable: false, eta: null, rate: null, courierId: null, courierName: null, express: null };
    if (r.serviceable) {
      // Standard = the CHEAPEST courier for this parcel; that's what we quote,
      // charge (in 'actual' mode) and assign at dispatch.
      const pick = pickCheapestCourier(r.couriers)
        || r.couriers.find((c) => c.courierId === r.recommendedId) || r.couriers[0];
      const express = pickExpressCourier(r.couriers);
      value = {
        serviceable: true,
        eta: etaFor(pick),
        rate: pick?.rate || null,
        courierId: pick?.courierId ?? null,
        courierName: pick?.name || null,
        express: express
          ? { eta: etaFor(express), rate: express.rate, courierId: express.courierId, courierName: express.name || null }
          : null,
      };
    }
    if (_serviceCache.size >= SERVICE_CACHE_MAX) _serviceCache.delete(_serviceCache.keys().next().value);
    _serviceCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    log.warn('delivery.shiprocket_serviceability_failed', { pincode, err });
    return null; // fail open — an outage must not block checkout
  }
}

/* ── the resolver ──────────────────────────────────────────────────────── */

/**
 * @param {{ pincode?: string, subtotal?: number, weightKg?: number }} input
 *   weightKg — the cart's billable parcel weight (packageService.quoteWeightKg)
 * @returns {Promise<{
 *   pincode: string|null,
 *   pincodeKnown: boolean,
 *   city: string|null,
 *   state: string|null,
 *   partner: 'shiprocket'|'local',
 *   deliveryAvailable: boolean,
 *   reason: string|null,
 *   standard: { available: boolean, fee: number, eta: string },
 *   fastest:  { available: boolean, fee: number, eta: string, reason: string|null },
 *   freeDeliveryApplied: boolean,
 *   estimatedShippingCost: number|null,   // INTERNAL — strip before sending to customers
 * }>}
 */
async function resolveDeliveryOptions({ pincode, subtotal = 0, weightKg } = {}) {
  const pin = normalisePincode(pincode);
  const sub = Math.max(0, Number(subtotal) || 0);
  const settings = await getGlobalSettings();

  const out = {
    pincode: isValidPincode(pin) ? pin : null,
    pincodeKnown: false,
    city: null,
    state: null,
    partner: 'shiprocket',
    deliveryAvailable: false,
    reason: null,
    standard: { available: false, fee: 0, eta: settings.defaultStandardEta },
    fastest: { available: false, fee: 0, eta: settings.defaultFastestEta, reason: null },
    freeDeliveryApplied: false,
    cutoffTime: settings.fastestCutoffTime || null,
    estimatedShippingCost: null,
  };

  if (pin && !isValidPincode(pin)) {
    out.reason = 'Invalid PIN code';
    return out;
  }

  const rule = pin ? await getPincodeRule(pin) : null;
  out.partner = partnerOf(rule);

  if (rule) {
    out.pincodeKnown = true;
    out.city = rule.city || null;
    out.state = rule.state || null;
    if (rule.deliveryAvailable === false) {
      out.reason = 'We do not deliver to this PIN code yet.';
      return out;
    }
  } else if (!settings.serviceByDefault) {
    out.reason = 'Delivery is currently unavailable for this PIN code.';
    return out;
  }

  // ── courier check (Shiprocket PINs only, rule or not) ──
  const courier = pin && out.partner === 'shiprocket' ? await getCourierServiceability(pin, weightKg) : null;
  if (courier && !courier.serviceable) {
    out.reason = 'Our courier partners do not deliver to this PIN code yet.';
    return out;
  }
  if (courier?.rate) {
    out.estimatedShippingCost = courier.rate;
    out.standard.courier = { courierId: courier.courierId, name: courier.courierName, rate: courier.rate };
  }

  // ── standard ──
  // Shiprocket PINs: the band for the live freight quote ALWAYS decides the fee
  // (custom PIN fees can't undercut the courier cost). Without a quote
  // (Shiprocket down) → per-0.5 kg fallback, so heavy carts still pay their way.
  // Local-partner PINs: custom PIN fee, else the flat default fee.
  out.standard.available = true;
  const bandFee = out.partner === 'shiprocket' ? courierLinkedFeeFor(courier?.rate, settings) : null;
  if (bandFee != null) {
    out.standard.fee = bandFee;
  } else if (rule && standardFeeTypeOf(rule) === 'custom') {
    out.standard.fee = clampFee(rule.standardDeliveryFee, settings.defaultDeliveryFee);
  } else if (out.partner === 'shiprocket') {
    out.standard.fee = clampFee(settings.defaultDeliveryFee * (weightSlab(weightKg) / 0.5), settings.defaultDeliveryFee);
  } else {
    out.standard.fee = settings.defaultDeliveryFee;
  }
  if (rule?.standardDeliveryEta) out.standard.eta = String(rule.standardDeliveryEta).slice(0, 60);
  else if (courier?.eta) out.standard.eta = courier.eta;

  // (Free delivery is switched off by policy — the customer always pays.)

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
    let eta = (rule && rule.fastestDeliveryEta) ? String(rule.fastestDeliveryEta).slice(0, 60) : settings.defaultFastestEta;

    // Fastest on Shiprocket = an air/express courier must serve this PIN.
    if (courier && !courier.express) {
      available = false;
      reason = 'Fastest delivery is not available for this PIN code.';
    } else if (courier?.express?.eta && !(rule && rule.fastestDeliveryEta)) {
      eta = courier.express.eta;
    }
    // Fastest is priced from the express courier's real quote via the same bands.
    if (courier?.express) {
      fee = courierLinkedFeeFor(courier.express.rate, settings) ?? fee;
    }
    if (available && settings.fastestMinOrderValue > 0 && sub > 0 && sub < settings.fastestMinOrderValue) {
      available = false;
      reason = `Fastest delivery needs a minimum order of ₹${settings.fastestMinOrderValue}.`;
    }
    if (available && settings.fastestMaxOrderValue > 0 && sub > settings.fastestMaxOrderValue) {
      available = false;
      reason = `Fastest delivery is not available above ₹${settings.fastestMaxOrderValue}.`;
    }

    out.fastest = { available, fee, eta, reason };
    if (courier?.express) {
      out.fastest.courier = { courierId: courier.express.courierId, name: courier.express.courierName, rate: courier.express.rate };
    }
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
 * @returns {Promise<{ fee:number, method:'standard'|'fastest', eta:string, freeDeliveryApplied:boolean,
 *   partner:'shiprocket'|'local', estimatedShippingCost:number|null }>}
 * @throws DeliveryError('DELIVERY_UNAVAILABLE' | 'FASTEST_UNAVAILABLE' | 'INVALID_PINCODE')
 */
async function computeDeliveryFee({ pincode, method = 'standard', subtotal = 0, weightKg } = {}) {
  const wanted = method === 'fastest' ? 'fastest' : 'standard';
  const opts = await resolveDeliveryOptions({ pincode, subtotal, weightKg });
  const extraFor = (o) => ({
    partner: opts.partner,
    // Freight + courier for the chosen method — saved on the order, assigned at dispatch.
    estimatedShippingCost: o.courier?.rate ?? opts.estimatedShippingCost,
    quotedCourier: o.courier || null,
  });

  if (!opts.deliveryAvailable) {
    throw new DeliveryError('DELIVERY_UNAVAILABLE', opts.reason || 'Delivery is unavailable for this PIN code.');
  }

  if (wanted === 'fastest') {
    if (!opts.fastest.available) {
      throw new DeliveryError('FASTEST_UNAVAILABLE', opts.fastest.reason || 'Fastest delivery is not available for this order.');
    }
    return { fee: opts.fastest.fee, method: 'fastest', eta: opts.fastest.eta, freeDeliveryApplied: false, ...extraFor(opts.fastest) };
  }

  return {
    fee: opts.standard.fee,
    method: 'standard',
    eta: opts.standard.eta,
    freeDeliveryApplied: opts.freeDeliveryApplied,
    ...extraFor(opts.standard),
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
  feeForCourierRate,
  courierLinkedFeeFor,
  pickCheapestCourier,
  pickExpressCourier,
  partnerOf,
  DeliveryError,
};
