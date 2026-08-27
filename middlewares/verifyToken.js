const { verifyIdToken, extractBearer } = require('../utils/firebaseAuth');
const log = require('../lib/logger');

/**
 * Express middleware: verifies the Firebase ID token in the Authorization
 * header and attaches a normalised `req.user` (role lowercased, deactivated
 * accounts rejected). Delegates all logic to utils/firebaseAuth so the
 * Socket.IO handshake shares the exact same rules.
 */
const verifyToken = async (req, res, next) => {
  try {
    const token = extractBearer(req.headers.authorization);
    req.user = await verifyIdToken(token);
    next();
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
