/**
 * asyncHandler(fn) — wrap an async route handler so a rejected promise is
 * forwarded to Express's error middleware instead of hanging the request.
 *
 *   router.post('/', asyncHandler(async (req, res) => { ... }));
 */
'use strict';

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
