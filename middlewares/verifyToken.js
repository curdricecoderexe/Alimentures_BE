const { authenticate } = require('../utils/firebaseAuth');
const log = require('../lib/logger');
const { csrfOriginCheck } = require('./requestGuards');

/**
 * Express middleware: verifies the Firebase ID token (Authorization header or
 * the httpOnly session cookie, refreshed when expired) and attaches a normalised `req.user` (role lowercased, deactivated
 * accounts rejected). Delegates all logic to utils/firebaseAuth so the
 * Socket.IO handshake shares the exact same rules.
 */
const verifyToken = async (req, res, next) => {
  try {
    const { user, via } = await authenticate({
      authorization: req.headers.authorization,
      cookieHeader: req.headers.cookie,
      res,
    });
    req.user = user;
    req.authVia = via;
    // Cookie sessions: writes must originate from our own site (CSRF defence).
    return csrfOriginCheck(() => req.app.get('allowedOrigins') || [])(req, res, next);
  } catch (err) {
    log.warn('auth.failed', {
      requestId: req.id,
      code: err.code,
      path: req.originalUrl,
      ip: req.ip,
    });
    return res
      .status(err.status || 401)
      .json({ success: false, error: err.publicMessage || 'Invalid session' });
  }
};

module.exports = verifyToken;
