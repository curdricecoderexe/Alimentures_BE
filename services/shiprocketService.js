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
 *
 * Parcel size/weight is NOT decided here — see packageService.js.
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

/*
 * Login circuit breaker. Shiprocket BLOCKS the API user after repeated failed
 * logins, and every checkout quote / tracking read / retry job needs a token —
 * so without this a single bad password turns into a login storm that gets the
 * account blocked (and keeps re-extending the block). After a rejected login we
 * stop calling /auth/login until `pausedUntil`, backing off 5 → 10 → 20 → 60 min
 * (30 min straight away if Shiprocket says the user is blocked). Network errors
 * and 5xx only pause for 1 minute.
 */
const BACKOFF_MS = [5, 10, 20, 60].map((m) => m * 60 * 1000);
const BLOCKED_PAUSE_MS = 30 * 60 * 1000;
const TRANSIENT_PAUSE_MS = 60 * 1000;
const MANUAL_TEST_GAP_MS = 60 * 1000;
let _auth = { failures: 0, pausedUntil: 0, lastError: null, lastFailureAt: 0, lastOkAt: 0, lastManualTestAt: 0 };

function authStatus() {
  const paused = _auth.pausedUntil > Date.now();
  return {
    ok: !!_token.value && !paused,
    paused,
    pausedUntil: paused ? new Date(_auth.pausedUntil).toISOString() : null,
    consecutiveFailures: _auth.failures,
    lastError: _auth.lastError,
    lastFailureAt: _auth.lastFailureAt ? new Date(_auth.lastFailureAt).toISOString() : null,
    lastOkAt: _auth.lastOkAt ? new Date(_auth.lastOkAt).toISOString() : null,
  };
}

function recordLoginFailure(err, { rejected }) {
  _auth.failures += 1;
  _auth.lastError = String(err.message || err).slice(0, 300);
  _auth.lastFailureAt = Date.now();
  let pause = TRANSIENT_PAUSE_MS;
  if (rejected) {
    pause = BACKOFF_MS[Math.min(_auth.failures - 1, BACKOFF_MS.length - 1)];
    if (/block|too many/i.test(_auth.lastError)) pause = Math.max(pause, BLOCKED_PAUSE_MS);
  }
  _auth.pausedUntil = Date.now() + pause;
  _token = { value: null, at: 0 };
  log.error('shiprocket.login_failed', {
    error: _auth.lastError,
    consecutiveFailures: _auth.failures,
    pausedForMin: Math.round(pause / 60000),
    note: rejected
      ? 'Check SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD are the API user (Settings → API), not the panel login. No further login attempts until the pause ends.'
      : 'Shiprocket unreachable; retrying shortly.',
  });
}

async function login() {
  const { email, password } = cfg();
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const e = new ShiprocketError(`Shiprocket login request failed: ${err.message}`);
    recordLoginFailure(e, { rejected: false });
    throw e;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    const e = new ShiprocketError(`Shiprocket login failed: ${body.message || res.status}`, { status: res.status, body });
    recordLoginFailure(e, { rejected: res.status < 500 });
    throw e;
  }
  _token = { value: body.token, at: Date.now() };
  _auth = { ..._auth, failures: 0, pausedUntil: 0, lastError: null, lastOkAt: Date.now() };
  log.info('shiprocket.login_ok');
  return body.token;
}

async function getToken({ force = false } = {}) {
  if (!force && _token.value && Date.now() - _token.at < TOKEN_TTL_MS) return _token.value;
  if (_auth.pausedUntil > Date.now()) {
    throw new ShiprocketError(
      `Shiprocket login paused until ${new Date(_auth.pausedUntil).toLocaleTimeString('en-IN')} after a failed login: ${_auth.lastError}`,
      { status: 503 },
    );
  }
  // Collapse concurrent logins into one request.
  if (!_loginInFlight) _loginInFlight = login().finally(() => { _loginInFlight = null; });
  return _loginInFlight;
}

/**
 * Admin "Test login": clears the pause and tries ONE login. Limited to one
 * attempt per minute so it can't be used to re-trigger a block.
 */
async function testLogin() {
  if (!isEnabled()) throw new ShiprocketError('Shiprocket is not configured');
  const wait = _auth.lastManualTestAt + MANUAL_TEST_GAP_MS - Date.now();
  if (wait > 0) throw new ShiprocketError(`Wait ${Math.ceil(wait / 1000)} s before testing the login again`, { status: 429 });
  _auth.lastManualTestAt = Date.now();
  _auth.pausedUntil = 0;
  _token = { value: null, at: 0 };
  await getToken({ force: true });
  return authStatus();
}

/** Test helper: forget all auth state. */
function _resetAuthForTests() {
  _token = { value: null, at: 0 };
  _loginInFlight = null;
  _auth = { failures: 0, pausedUntil: 0, lastError: null, lastFailureAt: 0, lastOkAt: 0, lastManualTestAt: 0 };
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
 * @param {{ length, breadth, height, weightKg }} pkg  parcel from packageService.buildPackage()
 */
async function createOrder(orderId, order, pkg) {
  if (!pkg || !(pkg.length > 0 && pkg.breadth > 0 && pkg.height > 0 && pkg.weightKg > 0)) {
    throw new ShiprocketError('Parcel size and weight are required');
  }
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
      // Catalogue SKU when set (required for Shiprocket Fulfillment), else a stable generated one.
      sku: (it.sku || `${it.productId}-${it.selectedWeight || 'std'}`).replace(/\s+/g, '').slice(0, 50),
      units: Number(it.quantity) || 1,
      selling_price: Number(it.price) || 0,
      ...(it.hsn ? { hsn: String(it.hsn) } : {}),
      ...(it.gstRate != null ? { tax: Number(it.gstRate) } : {}),
    })),
    payment_method: 'Prepaid',
    shipping_charges: Number(order.deliveryFee ?? order.shipping) || 0,
    total_discount: Number(order.discountAmount) || 0,
    sub_total: Number(order.subtotal) || 0,
    length: pkg.length,
    breadth: pkg.breadth,
    height: pkg.height,
    weight: pkg.weightKg,
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

/**
 * Cancel a Shiprocket order (only possible before the courier picks it up).
 * Cancelling also releases the freight hold on the wallet.
 */
async function cancelOrder(srOrderId) {
  await request('POST', '/orders/cancel', { body: { ids: [Number(srOrderId) || srOrderId] } });
  return true;
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
  authStatus,
  testLogin,
  _resetAuthForTests,
  ShiprocketError,
  checkServiceability,
  createOrder,
  assignAwb,
  generatePickup,
  generateLabel,
  cancelOrder,
  trackAwb,
};
