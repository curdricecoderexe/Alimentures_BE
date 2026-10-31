/**
 * chatAuth.js — Socket.IO handshake authentication.
 *
 * Every socket connection MUST present a valid Firebase ID token — either
 * io(URL, { auth: { token } }) or the httpOnly session cookie.
 *
 * On success `socket.user` is the same normalised object produced by
 * utils/firebaseAuth (uid, email, role lowercased, isActive). On failure the
 * connection is refused before any event handler runs.
 */

'use strict';

const { authenticate } = require('../utils/firebaseAuth');
const log = require('../lib/logger');

module.exports = function chatAuth(io) {
  io.use(async (socket, next) => {
    try {
      // Bearer token from the client, or the httpOnly session cookie that the
      // browser sends with the (same-origin) handshake.
      const token = socket.handshake.auth?.token || socket.handshake.query?.token || null;
      const { user } = await authenticate({
        authorization: token ? `Bearer ${token}` : undefined,
        cookieHeader: socket.handshake.headers?.cookie,
      });
      socket.user = user;
      return next();
    } catch (err) {
      log.warn('socket.auth_failed', { code: err.code, ip: socket.handshake.address });
      const e = new Error(err.publicMessage || 'Unauthorized');
      e.data = { code: err.code || 'auth/unauthorized' };
      return next(e);
    }
  });
};
