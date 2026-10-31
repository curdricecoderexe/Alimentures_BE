/**
 * requestGuards.js — input-shape guards applied to every /api request.
 *
 *   rejectOperatorQuery   query values must be plain strings: bracket keys
 *                         (q[$ne]=…, q[]=…) and arrays/objects are rejected, so
 *                         no handler can ever receive an operator object.
 *   requireJsonBody       write requests with a body must be JSON (or a route's
 *                         explicitly allowed raw type) — anything else is a 415,
 *                         never a 500 from a handler reading an undefined body.
 *   csrfOriginCheck       cookie-authenticated writes must come from our own
 *                         origin (defence in depth on top of SameSite=Strict).
 */
'use strict';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function rejectOperatorQuery(req, res, next) {
  for (const [key, value] of Object.entries(req.query || {})) {
    if (/[[\]$]/.test(key) || (value !== undefined && typeof value !== 'string')) {
      return res.status(400).json({ success: false, error: 'Invalid query parameter' });
    }
  }
  next();
}

/**
 * @param {Array<{ path: RegExp, types: RegExp }>} rawRoutes  routes that accept a non-JSON body
 */
function requireJsonBody(rawRoutes = []) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (!hasBody) {
      if (req.body === undefined) req.body = {};
      return next();
    }
    const type = String(req.headers['content-type'] || '').toLowerCase();
    const raw = rawRoutes.find((r) => r.path.test(req.originalUrl.split('?')[0]));
    const ok = raw ? raw.types.test(type) : /^application\/json\b/.test(type);
    if (!ok) return res.status(415).json({ success: false, error: 'Unsupported content type' });
    if (req.body === undefined) req.body = {};
    next();
  };
}

/** @param {() => string[]} getAllowedOrigins */
function csrfOriginCheck(getAllowedOrigins) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || req.authVia !== 'cookie') return next();
    const source = req.headers.origin || (() => {
      try { return new URL(req.headers.referer).origin; } catch { return null; }
    })();
    const self = `${req.protocol}://${req.get('host')}`;
    if (source && (source === self || getAllowedOrigins().includes(source))) return next();
    return res.status(403).json({ success: false, error: 'Forbidden' });
  };
}

module.exports = { rejectOperatorQuery, requireJsonBody, csrfOriginCheck, SAFE_METHODS };
