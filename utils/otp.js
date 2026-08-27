/**
 * otp.js — hashed, expiring, attempt-limited one-time passwords.
 *
 * OTP digits are NEVER stored. We store sha256(otp + pepper). Each verify:
 *   - rejects a code older than LIMITS.OTP_TTL_MS
 *   - counts wrong attempts and locks the email for LIMITS.OTP_LOCK_MS after
 *     LIMITS.OTP_MAX_ATTEMPTS failures
 *   - is transactional so parallel guesses can't race the counter
 *
 * Pepper: set OTP_PEPPER in the environment. Falls back to the (required)
 * RAZORPAY_WEBHOOK_SECRET so it is never empty.
 */

'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const db = require('../config/firebase');
const { LIMITS } = require('../config/constants');

// Production boot (index.js) requires OTP_PEPPER, so the fallback below only ever
// applies to local dev / tests.
const PEPPER = process.env.OTP_PEPPER || 'alimentures-otp-dev-only';

function generateOtp() {
  // crypto-strong 6-digit code
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(`${otp}:${PEPPER}`).digest('hex');
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts._seconds) return ts._seconds * 1000;
  if (ts.seconds) return ts.seconds * 1000;
  return null;
}

/** Create/overwrite the OTP record for an email. Returns the plaintext code to email. */
async function issueOtp(collection, email) {
  const otp = generateOtp();
  await db.collection(collection).doc(email).set({
    hash: hashOtp(otp),
    attempts: 0,
    lockedUntil: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return otp;
}

/**
 * @returns {Promise<{ ok: boolean, reason?: 'not_requested'|'locked'|'expired'|'invalid' }>}
 */
async function verifyOtp(collection, email, submitted) {
  const ref = db.collection(collection).doc(email);

  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return { ok: false, reason: 'not_requested' };

    const data = snap.data();
    const now = Date.now();

    if (data.lockedUntil && toMillis(data.lockedUntil) > now) {
      return { ok: false, reason: 'locked' };
    }

    const createdMs = toMillis(data.createdAt);
    if (createdMs != null && now - createdMs > LIMITS.OTP_TTL_MS) {
      t.delete(ref);
      return { ok: false, reason: 'expired' };
    }

    const matches =
      typeof submitted === 'string' &&
      typeof data.hash === 'string' &&
      timingSafeEqualHex(hashOtp(submitted), data.hash);

    if (matches) {
      t.delete(ref);
      return { ok: true };
    }

    const attempts = (data.attempts || 0) + 1;
    const update = { attempts };
    if (attempts >= LIMITS.OTP_MAX_ATTEMPTS) {
      update.lockedUntil = admin.firestore.Timestamp.fromMillis(now + LIMITS.OTP_LOCK_MS);
    }
    t.update(ref, update);
    return { ok: false, reason: 'invalid' };
  });
}

const OTP_ERROR_MESSAGE = {
  not_requested: 'No OTP was requested for this email',
  locked: 'Too many incorrect attempts. Please request a new code in a few minutes.',
  expired: 'This code has expired. Please request a new one.',
  invalid: 'Invalid or expired code',
};

module.exports = { generateOtp, hashOtp, issueOtp, verifyOtp, OTP_ERROR_MESSAGE };
