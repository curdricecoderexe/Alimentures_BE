/**
 * cronOrAdmin — allow a scheduled job (correct X-Cron-Secret header) OR a
 * logged-in admin. Use on endpoints hit by Render Cron:
 *
 *   router.post('/cleanup-reservations', cronOrAdmin, handler);
 */
'use strict';

const crypto = require('crypto');
const { verifyIdToken, extractBearer } = require('../utils/firebaseAuth');

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function cronOrAdmin(req, res, next) {
  if (secretMatches(req.headers['x-cron-secret'], process.env.RESERVATION_CLEANUP_SECRET)) {
    req.isCron = true;
    req.user = { uid: 'cron', role: 'admin', email: 'cron@system' };
    return next();
  }

  try {
    const user = await verifyIdToken(extractBearer(req.headers.authorization));
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin only access' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return res.status(err.status || 401).json({ success: false, error: err.publicMessage || 'Unauthorized' });
  }
};
