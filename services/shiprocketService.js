/**
 * shiprocketService.js — thin client for the Shiprocket external API
 * (https://apiv2.shiprocket.in/v1/external).
 *
 * Auth: Shiprocket issues a bearer token from an "API user" (Shiprocket panel →
 * Settings → API → Configure). Tokens are valid ~10 days; we cache one in
 * process, refresh it a day early, and re-login once on a 401.
 *
 * Integration is OPTIONAL: when SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD /
 * SHIPROCKET_PICKUP_LOCATION / SHIPROCKET_PICKUP_PINCODE are not all set,
 * `isEnabled()` is false and callers fall back to the manual fulfilment flow.
 */
'use strict';

const log = require('../lib/logger');

const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
const REQUEST_TIMEOUT_MS = 15 * 1000;
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000; // tokens last 10 days — refresh a day early

const cfg = () => ({
  email: process.env.SHIPROCKET_EMAIL,
  password: process.env.SHIPROCKET_PASSWORD,
  pickupLocation: process.env.SHIPROCKET_PICKUP_LOCATION,
  pickupPincode: String(process.env.SHIPROCKET_PICKUP_PINCODE || '').trim(),
  // Package defaults (cm / kg) used when an item's weight can't be parsed.
  length: Number(process.env.SHIPROCKET_PKG_LENGTH_CM) || 20,
  breadth: Number(process.env.SHIPROCKET_PKG_BREADTH_CM) || 15,
  height: Number(process.env.SHIPROCKET_PKG_HEIGHT_CM) || 10,
  defaultItemWeightKg: Number(process.env.SHIPROCKET_DEFAULT_ITEM_WEIGHT_KG) || 0.5,
});

function isEnabled() {
  const c = cfg();
  return !!(c.email && c.password && c.pickupLocation && /^[1-9][0-9]{5}$/.test(c.pickupPincode));
}

class ShiprocketError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ShiprocketError';
    this.status = status;
    this.body = body;
  }
}

/* ── auth ──────────────────────────────────────────────────────────────── */

let _token = { value: null, at: 0 };
let _loginInFlight = null;

async function login() {
  const { email, password } = cfg();
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    throw new ShiprocketError(`Shiprocket login failed: ${body.message || res.status}`, { status: res.status, body });
  }
  _token = { value: body.token, at: Date.now() };
  log.info('shiprocket.login_ok');
  return body.token;
}

async function getToken({ force = false } = {}) {
  if (!force && _token.value && Date.now() - _token.at < TOKEN_TTL_MS) return _token.value;
  // Collapse concurrent logins into one request.
  if (!_loginInFlight) _loginInFlight = login().finally(() => { _loginInFlight = null; });
  return _loginInFlight;
}

/* ── request helper ────────────────────────────────────────────────────── */

async function request(method, path, { query, body } = {}, retried = false) {
  if (!isEnabled()) throw new ShiprocketError('Shiprocket is not configured');
  const token = await getToken();
  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    Object.entries(query).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, String(v)); });
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status === 401 && !retried) {
    await getToken({ force: true });
    return request(method, path, { query, body }, true);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || (data.errors && JSON.stringify(data.errors)) || `HTTP ${res.status}`;
    throw new ShiprocketError(`Shiprocket ${method} ${path} failed: ${msg}`, { status: res.status, body: data });
  }
  return data;
}

/* ── helpers ───────────────────────────────────────────────────────────── */

/** "500g" → 0.5, "1kg" → 1, "1.5 KG" → 1.5; anything else → null. */
function parseWeightKg(label) {
  const m = String(label || '').trim().toLowerCase().match(/^([\d.]+)\s*(kg|kgs|g|gm|gms|gram|grams)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].startsWith('k') ? n : n / 1000;
}

/** Total parcel weight in kg (rounded up to 10 g, minimum 0.1 kg). */
function packageWeightKg(items = []) {
  const { defaultItemWeightKg } = cfg();
  const total = items.reduce((sum, it) => {
    const per = parseWeightKg(it.selectedWeight) ?? defaultItemWeightKg;
    return sum + per * (Number(it.quantity) || 1);
  }, 0);
  return Math.max(0.1, Math.ceil(total * 100) / 100);
}

/** Shiprocket wants a bare 10-digit Indian mobile number. */
const tenDigitPhone = (p) => String(p || '').replace(/\D/g, '').slice(-10);

const pad = (n) => String(n).padStart(2, '0');
function srDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ── API surface ───────────────────────────────────────────────────────── */

/**
 * Courier serviceability for a delivery PIN (prepaid).
 * @returns {Promise<{ serviceable: boolean, couriers: Array, recommendedId: number|null }>}
 */
async function checkServiceability({ deliveryPincode, weightKg = 0.5, srOrderId } = {}) {
  const query = srOrderId
    ? { order_id: srOrderId }
    : { pickup_postcode: cfg().pickupPincode, delivery_postcode: deliveryPincode, weight: weightKg, cod: 0 };
  let data;
  try {
    data = await request('GET', '/courier/serviceability/', { query });
  } catch (err) {
    // Shiprocket answers 404 for "no courier serviceable" — that's a real "no", not an outage.
    if (err instanceof ShiprocketError && err.status === 404) {
      return { serviceable: false, couriers: [], recommendedId: null };
    }
    throw err;
  }
  const list = data?.data?.available_courier_companies || [];
  const couriers = list.map((c) => ({
    courierId: c.courier_company_id,
    name: c.courier_name,
    rate: Number(c.rate ?? c.freight_charge) || 0,
    etd: c.etd || null,
    estimatedDays: Number(c.estimated_delivery_days) || null,
    rating: Number(c.rating) || null,
    isSurface: !!c.is_surface,
  }));
  return {
    serviceable: couriers.length > 0,
    couriers,
    recommendedId: data?.data?.recommended_courier_company_id || null,
  };
}

/**
 * Push an Alimenture order to Shiprocket ("custom order" / adhoc).
 * Our Firestore order id is used as Shiprocket's channel `order_id`, so the
 * webhook can map back to it.
 */
async function createOrder(orderId, order) {
  const c = cfg();
  const ci = order.customerInfo || {};
  const items = order.items || [];
  const payload = {
    order_id: orderId,
    order_date: srDate(order.paidAt?.toDate ? order.paidAt.toDate() : new Date()),
    pickup_location: c.pickupLocation,
    billing_customer_name: ci.firstName || ci.name || 'Customer',
    billing_last_name: ci.lastName || '',
    billing_address: ci.address,
    billing_city: ci.city,
    billing_pincode: ci.pincode || order.deliveryPincode,
    billing_state: ci.state,
    billing_country: 'India',
    billing_email: ci.email,
    billing_phone: tenDigitPhone(ci.phone),
    shipping_is_billing: true,
    order_items: items.map((it) => ({
      name: it.name,
      sku: `${it.productId}-${it.selectedWeight || 'std'}`.replace(/\s+/g, '').slice(0, 50),
      units: Number(it.quantity) || 1,
      selling_price: Number(it.price) || 0,
    })),
    payment_method: 'Prepaid',
    shipping_charges: Number(order.deliveryFee ?? order.shipping) || 0,
    total_discount: Number(order.discountAmount) || 0,
    sub_total: Number(order.subtotal) || 0,
    length: c.length,
    breadth: c.breadth,
    height: c.height,
    weight: packageWeightKg(items),
  };
  const data = await request('POST', '/orders/create/adhoc', { body: payload });
  if (!data.shipment_id) {
    throw new ShiprocketError(`Shiprocket did not return a shipment: ${data.message || 'unknown error'}`, { body: data });
  }
  return {
    srOrderId: data.order_id,
    shipmentId: data.shipment_id,
    srStatus: data.status || 'NEW',
    weightKg: payload.weight,
  };
}

/** Assign an AWB (courier). Omit courierId to let Shiprocket pick its recommended courier. */
async function assignAwb(shipmentId, courierId) {
  const body = { shipment_id: shipmentId };
  if (courierId) body.courier_id = courierId;
  const data = await request('POST', '/courier/assign/awb', { body });
  const d = data?.response?.data || {};
  if (data.awb_assign_status !== 1 || !d.awb_code) {
    throw new ShiprocketError(`AWB assignment failed: ${d.awb_assign_error || data.message || 'unknown error'}`, { body: data });
  }
  return { awb: d.awb_code, courierId: d.courier_company_id, courierName: d.courier_name };
}

async function generatePickup(shipmentId) {
  const data = await request('POST', '/courier/generate/pickup', { body: { shipment_id: [shipmentId] } });
  return {
    scheduledDate: data?.response?.pickup_scheduled_date || null,
    token: data?.response?.pickup_token_number || null,
  };
}

async function generateLabel(shipmentId) {
  const data = await request('POST', '/courier/generate/label', { body: { shipment_id: [shipmentId] } });
  if (!data.label_url) throw new ShiprocketError('Label not generated yet', { body: data });
  return data.label_url;
}

/** Normalised tracking for an AWB. */
async function trackAwb(awb) {
  const data = await request('GET', `/courier/track/awb/${encodeURIComponent(awb)}`);
  const t = data?.tracking_data || {};
  const latest = (t.shipment_track || [])[0] || {};
  return {
    status: String(latest.current_status || '').toUpperCase() || null,
    etd: t.etd || latest.edd || null,
    trackUrl: t.track_url || null,
    activities: (t.shipment_track_activities || []).slice(0, 25).map((a) => ({
      date: a.date || null,
      status: a['sr-status-label'] || a.status || '',
      activity: a.activity || '',
      location: a.location || '',
    })),
  };
}

module.exports = {
  isEnabled,
  ShiprocketError,
  checkServiceability,
  createOrder,
  assignAwb,
  generatePickup,
  generateLabel,
  trackAwb,
  packageWeightKg,
  parseWeightKg,
};
