/**
 * chatAuth.js — Socket.IO handshake authentication.
 *
 * Every socket connection MUST present a valid Firebase ID token:
 *   io(URL, { auth: { token } })
 *
 * On success `socket.user` is the same normalised object produced by
 * utils/firebaseAuth (uid, email, role lowercased, isActive). On failure the
 * connection is refused before any event handler runs.
 */

'use strict';

const { verifyIdToken } = require('../utils/firebaseAuth');
const log = require('../lib/logger');

module.exports = function chatAuth(io) {
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.query?.token ||
        null;
      socket.user = await verifyIdToken(token);
      return next();
    } catch (err) {
      log.warn('socket.auth_failed', { code: err.code, ip: socket.handshake.address });
      const e = new Error(err.publicMessage || 'Unauthorized');
      e.data = { code: err.code || 'auth/unauthorized' };
      return next(e);
    }
  });
};
