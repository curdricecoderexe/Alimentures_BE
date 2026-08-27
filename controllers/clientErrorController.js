'use strict';

const log = require('../lib/logger');

const trim = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

/**
 * POST /api/client-errors
 * Public, tightly rate-limited. The frontend ErrorBoundary + global error
 * handlers POST here; each report is logged as `client.error`, which the
 * structured logger forwards to ERROR_WEBHOOK_URL when configured.
 */
exports.report = (req, res) => {
  const body = req.body || {};
  log.error('client.error', {
    requestId: req.id,
    ip: req.ip,
    message: trim(body.message, 500) || 'unknown client error',
    name: trim(body.name, 120),
    stack: trim(body.stack, 4000),
    componentStack: trim(body.componentStack, 4000),
    url: trim(body.url, 500),
    userAgent: trim(body.userAgent, 300) || trim(req.headers['user-agent'], 300),
    release: trim(body.release, 60),
  });
  // Always 204 — the client must never retry or surface this.
  return res.status(204).end();
};
