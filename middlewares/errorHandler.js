/**
 * errorHandler.js — terminal error middleware + 404 handler.
 *
 * Guarantees:
 *   - Clients NEVER receive a stack trace, a raw Firestore/driver message, or
 *     internal paths. 5xx responses are always the generic message.
 *   - Every response carries the requestId so a client report can be traced to
 *     the full server-side log line.
 *   - 4xx errors that explicitly opt in (`err.expose === true`, e.g. the typed
 *     errors from utils/firebaseAuth) may surface `err.publicMessage`.
 */

'use strict';

const log = require('../lib/logger');

function notFound(req, res, next) {
  const err = new Error('Not found');
  err.status = 404;
  err.expose = true;
  err.publicMessage = 'Not found';
  next(err);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Normalise common framework errors
  let status = err.status || err.statusCode || 500;
  let publicMessage = err.publicMessage;

  if (err.type === 'entity.too.large') {
    status = 413;
    publicMessage = 'Request body too large';
  } else if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    status = 400;
    publicMessage = 'Malformed request body';
  } else if (err.message === 'Not allowed by CORS') {
    status = 403;
    publicMessage = 'Origin not allowed';
  }

  const isClientError = status >= 400 && status < 500;
  const safeMessage = (isClientError && (err.expose || publicMessage))
    ? (publicMessage || 'Bad request')
    : 'Something went wrong';

  // Full detail server-side only
  const logFields = {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    status,
    ip: req.ip,
    err,
  };
  if (status >= 500) log.error('request.error', logFields);
  else log.warn('request.client_error', logFields);

  if (res.headersSent) return next(err);

  res.status(status).json({
    success: false,
    error: safeMessage,
    requestId: req.id,
  });
}

module.exports = { notFound, errorHandler };
