/**
 * Session handling: Bearer vs httpOnly cookie, transparent refresh, the
 * email-verification rule (F-17) and deactivated accounts.
 * Firebase token verification and the token-refresh endpoint are stubbed.
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, mockRes } = require('./helpers/setup');
const admin = require('../lib/firebaseAdmin');
const { authenticate, invalidateUser } = require('../utils/firebaseAuth');
const session = require('../lib/session');

// Fake tokens: "jwt.<uid>.<verified|unverified|expired>"
const realAuth = admin.auth;
const realFetch = global.fetch;
beforeEach(() => {
  db.reset();
  ['u1', 'u2', 'u3'].forEach(invalidateUser);
  db.seed('users/u1', { email: 'a@example.com', role: 'customer', isActive: true });
  db.seed('users/u2', { email: 'b@example.com', role: 'customer', isActive: true, emailVerified: true });
  db.seed('users/u3', { email: 'c@example.com', role: 'customer', isActive: false, emailVerified: true });
  Object.defineProperty(admin, 'auth', {
    configurable: true,
    value: () => ({
      verifyIdToken: async (t) => {
        const [, uid, state] = String(t).split('.');
        if (state === 'expired') { const e = new Error('expired'); e.code = 'auth/id-token-expired'; throw e; }
        return { uid, email_verified: state === 'verified', iat: Math.floor(Date.now() / 1000) };
      },
    }),
  });
});
afterEach(() => {
  Object.defineProperty(admin, 'auth', { configurable: true, value: realAuth });
  global.fetch = realFetch;
});

const cookie = (pairs) => Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ');

test('Bearer token with a verified email authenticates', async () => {
  const { user, via } = await authenticate({ authorization: 'Bearer jwt.u1.verified' });
  assert.equal(user.uid, 'u1');
  assert.equal(via, 'bearer');
});

test('F-17: unverified email is refused unless the account was verified by code', async () => {
  await assert.rejects(authenticate({ authorization: 'Bearer jwt.u1.unverified' }), (e) => e.status === 403);
  const { user } = await authenticate({ authorization: 'Bearer jwt.u2.unverified' }); // users/u2.emailVerified
  assert.equal(user.uid, 'u2');
});

test('deactivated accounts are refused', async () => {
  await assert.rejects(authenticate({ authorization: 'Bearer jwt.u3.verified' }), (e) => e.status === 403);
});

test('the httpOnly cookie authenticates when no real Bearer token is sent', async () => {
  const { user, via } = await authenticate({
    authorization: 'Bearer cookie-session', // the frontend's non-secret marker
    cookieHeader: cookie({ [session.ID_COOKIE]: 'jwt.u2.verified' }),
  });
  assert.equal(user.uid, 'u2');
  assert.equal(via, 'cookie');
});

test('an expired cookie session is refreshed and new cookies are set', async () => {
  global.fetch = async (url) => {
    assert.match(String(url), /securetoken\.googleapis\.com/);
    return { ok: true, json: async () => ({ id_token: 'jwt.u2.verified', refresh_token: 'rt-2', expires_in: '3600' }) };
  };
  const res = mockRes();
  const { user } = await authenticate({
    cookieHeader: cookie({ [session.ID_COOKIE]: 'jwt.u2.expired', [session.REFRESH_COOKIE]: 'rt-1' }),
    res,
  });
  assert.equal(user.uid, 'u2');
  assert.equal(res.cookies[session.ID_COOKIE].value, 'jwt.u2.verified');
  assert.equal(res.cookies[session.REFRESH_COOKIE].value, 'rt-2');
  assert.equal(res.cookies[session.ID_COOKIE].options.httpOnly, true);
  assert.equal(res.cookies[session.ID_COOKIE].options.sameSite, 'strict');
});

test('a revoked refresh token ends the session and clears the cookies', async () => {
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({}) });
  const res = mockRes();
  await assert.rejects(
    authenticate({ cookieHeader: cookie({ [session.REFRESH_COOKIE]: 'revoked' }), res }),
    (e) => e.status === 401,
  );
  assert.ok(res.cookies[session.ID_COOKIE].cleared && res.cookies[session.REFRESH_COOKIE].cleared);
});

test('no credentials at all is a 401', async () => {
  await assert.rejects(authenticate({}), (e) => e.status === 401);
});

test('parseCookies handles encoding and duplicates safely', () => {
  assert.deepEqual(session.parseCookies('a=1; b=hello%20world; a=2; bad'), { a: '1', b: 'hello world' });
  assert.deepEqual(session.parseCookies(undefined), {});
});
