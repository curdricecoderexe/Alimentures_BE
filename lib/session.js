/**
 * session.js — browser sessions in httpOnly cookies.
 *
 * The storefront and API share one origin in production (Nginx serves the SPA
 * and proxies /api + /socket.io), so the Firebase ID token and refresh token
 * live in httpOnly, Secure, SameSite=Strict cookies instead of localStorage —
 * page JavaScript (and therefore any XSS) can never read them. An expired ID
 * token is refreshed transparently from the refresh-token cookie.
 */
'use strict';

const ID_COOKIE = 'alim_id';
const REFRESH_COOKIE = 'alim_rt';
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // re-login at least monthly

const isProd = () => process.env.NODE_ENV === 'production';

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: isProd(), // browsers also accept Secure cookies on http://localhost
    sameSite: 'strict',
    path: '/',
    maxAge,
  };
}

/** Minimal Cookie header parser (no dependency). */
function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || out[k] !== undefined) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function setSessionCookies(res, { idToken, refreshToken, expiresIn }) {
  if (!res || typeof res.cookie !== 'function') return;
  const idMaxAge = Math.max(60, Number(expiresIn) || 3600) * 1000;
  if (idToken) res.cookie(ID_COOKIE, idToken, cookieOptions(idMaxAge));
  if (refreshToken) res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(REFRESH_MAX_AGE_MS));
}

function clearSessionCookies(res) {
  if (!res || typeof res.clearCookie !== 'function') return;
  const { maxAge, ...opts } = cookieOptions(0); // eslint-disable-line no-unused-vars
  res.clearCookie(ID_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, opts);
}

/** Exchange a Firebase refresh token for a fresh ID token. Throws on failure. */
async function refreshIdToken(refreshToken) {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key || !refreshToken) throw new Error('refresh_unavailable');
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`refresh_failed_${res.status}`);
  const data = await res.json();
  return { idToken: data.id_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

module.exports = {
  ID_COOKIE,
  REFRESH_COOKIE,
  parseCookies,
  setSessionCookies,
  clearSessionCookies,
  refreshIdToken,
};
