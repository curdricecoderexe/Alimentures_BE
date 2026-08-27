/**
 * firebaseAuth.js — one code path for verifying a Firebase ID token.
 *
 * Used by both the Express middleware (middlewares/verifyToken.js) and the
 * Socket.IO handshake (socket/chatAuth.js) so the rules never drift.
 *
 * Returns a normalised user object:
 *   { uid, email, role (lowercase), isActive, ...otherUserDocFields }
 *
 * Throws an Error with `.status` and `.publicMessage` set, so callers can
 * translate it to an HTTP response or a socket rejection.
 */

'use strict';

const admin = require('firebase-admin');
const db = require('../config/firebase');

// ── Short-TTL cache of the Firestore users/{uid} doc ──────────────────────────
// The ID-token signature check is cheap local crypto; the per-request Firestore
// read for role/isActive is the cost. Cache it briefly. A role/deactivation
// change takes effect within USER_CACHE_TTL_MS (and immediately on the user's
// next fresh token if `invalidateUser` is called on the write path).
const USER_CACHE_TTL_MS = 60 * 1000;
const USER_CACHE_MAX = 5000;
const userCache = new Map(); // uid -> { data, exp }

function cacheGet(uid) {
  const hit = userCache.get(uid);
  if (hit && hit.exp > Date.now()) return hit.data;
  if (hit) userCache.delete(uid);
  return null;
}
function cacheSet(uid, data) {
  if (userCache.size >= USER_CACHE_MAX) {
    const oldest = userCache.keys().next().value;
    userCache.delete(oldest);
  }
  userCache.set(uid, { data, exp: Date.now() + USER_CACHE_TTL_MS });
}
function invalidateUser(uid) {
  userCache.delete(uid);
}

function authError(status, publicMessage, code) {
  const e = new Error(publicMessage);
  e.status = status;
  e.publicMessage = publicMessage;
  e.expose = true;
  if (code) e.code = code;
  return e;
}

/**
 * @param {string} rawToken - the bare ID token (no "Bearer " prefix)
 * @returns {Promise<object>} normalised user
 */
async function verifyIdToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string' || rawToken === 'null' || rawToken === 'undefined') {
    throw authError(401, 'Authentication required', 'auth/no-token');
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(rawToken);
  } catch (err) {
    const publicMessage = err.code === 'auth/id-token-expired' ? 'Session expired' : 'Invalid session';
    throw authError(401, publicMessage, err.code || 'auth/invalid-token');
  }

  let data = cacheGet(decoded.uid);
  if (!data) {
    const userDoc = await db.collection('users').doc(decoded.uid).get();
    if (!userDoc.exists) {
      throw authError(401, 'Invalid session', 'auth/user-not-found');
    }
    data = userDoc.data() || {};
    cacheSet(decoded.uid, data);
  }

  if (data.isActive === false) {
    invalidateUser(decoded.uid);
    throw authError(403, 'Your account has been deactivated. Please contact support.', 'auth/account-disabled');
  }

  // Tokens issued before an explicit logout / forced sign-out are rejected.
  const validAfter = data.tokensValidAfter?.toMillis
    ? data.tokensValidAfter.toMillis()
    : (data.tokensValidAfter?._seconds ? data.tokensValidAfter._seconds * 1000 : 0);
  if (validAfter && (decoded.iat || 0) * 1000 < validAfter) {
    throw authError(401, 'Session ended. Please sign in again.', 'auth/session-revoked');
  }

  return {
    ...data,
    uid: decoded.uid,
    email: data.email || decoded.email || null,
    role: (data.role || 'customer').toString().toLowerCase(),
    isActive: data.isActive !== false,
  };
}

/** Pull the bare token out of an `Authorization: Bearer <token>` header. */
function extractBearer(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const parts = headerValue.split('Bearer ');
  return parts.length === 2 ? parts[1].trim() : null;
}

module.exports = { verifyIdToken, extractBearer, authError, invalidateUser };
