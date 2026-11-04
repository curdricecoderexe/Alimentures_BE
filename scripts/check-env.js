/**
 * check-env.js — go-live readiness check for the .env on THIS machine.
 * Prints which settings are present / suspicious, NEVER their secret values.
 *
 *   npm run check:env              # local
 *   NODE_ENV=production npm run check:env   # on the VPS
 *
 * Exit code 1 when anything blocking is wrong.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env');
if (!fs.existsSync(envPath)) {
  console.error(`No .env at ${envPath}`);
  process.exit(1);
}
const text = fs.readFileSync(envPath, 'utf8');
const env = { ...require('dotenv').parse(text), ...pick(process.env, ['NODE_ENV']) };
const rawLines = Object.fromEntries(text.split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

function pick(obj, keys) { return Object.fromEntries(keys.filter((k) => obj[k]).map((k) => [k, obj[k]])); }

const prod = (env.NODE_ENV || '').toLowerCase() === 'production';
const rows = [];
let blocking = 0;
const add = (level, key, msg) => { rows.push([level, key, msg]); if (level === 'FAIL') blocking += 1; };
const has = (k) => !!(env[k] && String(env[k]).trim());

/* parsing pitfalls: unquoted # or $ silently truncate / expand */
for (const [k, raw] of Object.entries(rawLines)) {
  const quoted = /^\s*['"]/.test(raw);
  if (!quoted && (env[k] || '').length < raw.trim().length) {
    add('FAIL', k, `value is cut short (reads ${(env[k] || '').length} of ${raw.trim().length} chars — a "#" starts a comment) — wrap it in single quotes`);
  }
  if (!quoted && raw.includes('$')) {
    add('WARN', k, 'contains "$" unquoted — fine for Node, but shells/Docker expand it; wrap in single quotes');
  }
  if (raw !== raw.trimEnd()) add('WARN', k, 'has trailing whitespace');
}

/* core */
for (const k of ['PORT', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_WEB_API_KEY']) {
  if (!has(k)) add('FAIL', k, 'missing (server will not start)');
}
if (has('FIREBASE_SERVICE_ACCOUNT_JSON')) {
  try { JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON); } catch { add('FAIL', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'is not valid JSON'); }
}
for (const k of ['CORS_ORIGIN', 'OTP_PEPPER', 'RESERVATION_CLEANUP_SECRET']) {
  if (!has(k)) add(prod ? 'FAIL' : 'WARN', k, prod ? 'missing (required in production)' : 'missing (required in production)');
}

/* Razorpay */
const keyId = env.RAZORPAY_KEY_ID || '';
const mode = keyId.startsWith('rzp_live_') ? 'live' : keyId.startsWith('rzp_test_') ? 'test' : null;
if (!mode) add('FAIL', 'RAZORPAY_KEY_ID', 'missing or not a Razorpay key id');
else if (prod && mode !== 'live') add('FAIL', 'RAZORPAY_KEY_ID', 'TEST key in production — customers cannot really pay');
else if (!prod && mode === 'live') add('WARN', 'RAZORPAY_KEY_ID', 'LIVE key on a non-production machine — test orders charge real money');
else add('OK', 'RAZORPAY_KEY_ID', `${mode} mode`);
for (const k of ['RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
  if (!has(k)) add('FAIL', k, 'missing');
}

/* Shiprocket */
const sr = ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_PICKUP_LOCATION', 'SHIPROCKET_PICKUP_PINCODE'];
const srSet = sr.filter(has);
if (srSet.length === 0) {
  add(prod ? 'FAIL' : 'WARN', 'SHIPROCKET_*', 'not configured — shipping is manual, no courier checks');
} else {
  sr.filter((k) => !has(k)).forEach((k) => add('FAIL', k, 'missing — Shiprocket stays DISABLED until all four are set'));
  if (has('SHIPROCKET_EMAIL') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.SHIPROCKET_EMAIL)) add('FAIL', 'SHIPROCKET_EMAIL', 'is not an email address');
  if (has('SHIPROCKET_PICKUP_PINCODE') && !/^[1-9][0-9]{5}$/.test(env.SHIPROCKET_PICKUP_PINCODE)) add('FAIL', 'SHIPROCKET_PICKUP_PINCODE', 'must be a 6-digit PIN');
  if (has('SHIPROCKET_PICKUP_LOCATION')) add('OK', 'SHIPROCKET_PICKUP_LOCATION', `"${env.SHIPROCKET_PICKUP_LOCATION}" — must match the nickname in Shiprocket → Pickup Addresses exactly`);
  if (!has('SHIPROCKET_WEBHOOK_TOKEN')) add('WARN', 'SHIPROCKET_WEBHOOK_TOKEN', 'missing — no live tracking updates');
  if (srSet.length === 4) add('OK', 'SHIPROCKET_*', 'configured — verify the login once with: npm run sr:test-login');
}

/* nice to have */
if (!has('ERROR_WEBHOOK_URL')) add('WARN', 'ERROR_WEBHOOK_URL', 'missing — production errors will not alert you');
const smtp = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter((k) => !has(k));
if (smtp.length) add(prod ? 'FAIL' : 'WARN', 'SMTP_*', `missing ${smtp.join(', ')} — OTP / order emails will not be sent`);

const icon = { OK: '✔', WARN: '⚠', FAIL: '✖' };
console.log(`\n.env check (${prod ? 'production' : 'non-production'}) — ${envPath}\n`);
for (const [lvl, k, msg] of rows) console.log(`${icon[lvl]} ${lvl.padEnd(4)} ${k.padEnd(28)} ${msg}`);
console.log(blocking ? `\n${blocking} blocking problem(s).` : '\nNo blocking problems.');
process.exit(blocking ? 1 : 0);
