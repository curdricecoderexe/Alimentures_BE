/**
 * firebase.js — Firebase Admin initialisation.
 *
 * Credentials come ONLY from the FIREBASE_SERVICE_ACCOUNT_JSON environment
 * variable (set in Render / your secret manager). There is no local key-file
 * fallback — a service-account key must never sit in the repo tree.
 *
 * Production / development: missing or invalid credentials are a fatal startup
 * error (process exits).
 * Test (NODE_ENV=test): exports null so Firestore-dependent suites can detect
 * the environment-blocked state and skip instead of crashing.
 */

'use strict';

const admin = require('firebase-admin');

function resolveServiceAccount() {
  const envJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!envJson || envJson.trim().length < 10) {
    throw new Error('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON is not set.');
  }
  let parsed;
  try {
    parsed = JSON.parse(envJson);
  } catch (err) {
    throw new Error(`[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${err.message}`);
  }
  if (!parsed.project_id || !parsed.private_key) {
    throw new Error('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id or private_key.');
  }
  return parsed;
}

let db;

try {
  const serviceAccount = resolveServiceAccount();
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  db = admin.firestore();
} catch (initErr) {
  if (process.env.NODE_ENV === 'test') {
    console.warn('[Firebase] Initialization skipped in test environment:', initErr.message);
    db = null;
  } else {
    console.error('[Firebase] FATAL: Cannot initialise Firebase Admin SDK.');
    console.error('[Firebase]', initErr.message);
    process.exit(1);
  }
}

module.exports = db;
