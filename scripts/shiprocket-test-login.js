/**
 * shiprocket-test-login.js — ONE Shiprocket login attempt with the credentials
 * in .env. Prints only the outcome (never the password or token).
 *
 *   npm run sr:test-login
 *
 * Every failed attempt counts toward Shiprocket's lock ("User blocked due to
 * too many failed login attempts" — 2 hours). Run it once after changing the
 * credentials, not in a loop.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const email = process.env.SHIPROCKET_EMAIL;
const password = process.env.SHIPROCKET_PASSWORD;

if (!email || !password) {
  console.error('SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD are not set in .env — nothing to test.');
  process.exit(2);
}

(async () => {
  try {
    const res = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (body.token) {
      console.log(`LOGIN OK — API user ${email} (password length ${password.length})`);
      process.exit(0);
    }
    const msg = body.message || `HTTP ${res.status}`;
    console.error(`LOGIN FAILED (HTTP ${res.status}): ${msg}`);
    if (/block|too many/i.test(msg)) {
      console.error('→ The API user is locked. Make NO further attempts (local or production) until the lock ends.');
    } else if (/invalid/i.test(msg)) {
      console.error(`→ Shiprocket rejects ${email} + this password (length ${password.length}). Check it is listed under`);
      console.error('  Settings → API → API Users, reset its password (letters + digits only), update .env and retry ONCE.');
    }
    process.exit(1);
  } catch (err) {
    console.error(`Could not reach Shiprocket: ${err.message}`);
    process.exit(1);
  }
})();
