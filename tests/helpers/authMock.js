/**
 * Shared auth stub for emulator integration tests.
 *
 * Usage (MUST be called at the very top of a test file — vi.mock is hoisted):
 *
 *   import { vi } from 'vitest';
 *   vi.mock('../utils/firebaseAuth', () => require('./helpers/authMock').mockModule());
 *
 * Then authenticate a request with:
 *   .set('Authorization', bearer(uid, role, email))
 */

function makeVerify() {
  return async (raw) => {
    if (typeof raw === 'string' && raw.startsWith('test|')) {
      const [, uid, role = 'customer', email] = raw.split('|');
      return { uid, role, email: email || `${uid}@test.dev`, isActive: true, name: uid };
    }
    const e = new Error('Authentication required');
    e.status = 401;
    e.publicMessage = 'Authentication required';
    e.expose = true;
    e.code = 'auth/no-token';
    throw e;
  };
}

exports.mockModule = () => {
  const verifyIdToken = makeVerify();
  return {
    verifyIdToken,
    invalidateUser: () => {},
    extractBearer: (h) => {
      if (!h || typeof h !== 'string') return null;
      const parts = h.split('Bearer ');
      return parts.length === 2 ? parts[1].trim() : null;
    },
    authError: (status, publicMessage, code) => {
      const e = new Error(publicMessage);
      e.status = status; e.publicMessage = publicMessage; e.expose = true;
      if (code) e.code = code;
      return e;
    },
  };
};

exports.bearer = (uid, role = 'customer', email) => `Bearer test|${uid}|${role}|${email || ''}`;
