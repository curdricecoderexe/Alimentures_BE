/**
 * logger.js — minimal structured (JSON-line) logger + optional error forwarding.
 *
 * Every line is a single JSON object so it is greppable and ingestible by Render
 * or any log pipeline.
 *
 * Error forwarding: set ERROR_WEBHOOK_URL to a collector endpoint (Slack Incoming
 * Webhook, Better Stack, a Sentry relay, etc.) and every `log.error(...)` is also
 * POSTed there as JSON — fire-and-forget, never blocks the request. For full
 * tracing, `@sentry/node` can be added later and hooked into `forwardError`.
 *
 * Usage:
 *   const log = require('../lib/logger');
 *   log.info('order.created', { orderId, requestId: req.id });
 *   log.error('webhook.failed', { requestId: req.id, err });
 */

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] || (process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);
const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL || null;
const SERVICE = 'alimentures-api';

function serializeError(err) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, code: err.code, stack: err.stack };
  }
  return err;
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'logger.stringify_failed' });
  }
}

const FORWARD_MAX_BYTES = 12 * 1024; // keep webhook payloads small

function forwardError(line) {
  if (!ERROR_WEBHOOK_URL || typeof fetch !== 'function') return;
  let body = safeStringify({ service: SERVICE, env: process.env.NODE_ENV, ...line });
  if (body.length > FORWARD_MAX_BYTES) {
    // Drop the big fields (stack, componentStack) rather than send a huge payload.
    const { err, stack, componentStack, ...slim } = line;
    body = safeStringify({
      service: SERVICE, env: process.env.NODE_ENV, ...slim,
      err: err ? { name: err.name, message: err.message, code: err.code } : undefined,
      truncated: true,
    });
  }
  // Fire-and-forget with a short timeout; a logging failure must never affect the request.
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 3000) : null;
  fetch(ERROR_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: ctl ? ctl.signal : undefined,
  }).catch(() => {}).finally(() => { if (timer) clearTimeout(timer); });
}

function emit(level, event, fields = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const { err, ...rest } = fields;
  const line = { ts: new Date().toISOString(), level, service: SERVICE, event, ...rest };
  if (err !== undefined) line.err = serializeError(err);

  const text = safeStringify(line);
  if (level === 'error') {
    process.stderr.write(text + '\n');
    forwardError(line);
  } else {
    process.stdout.write(text + '\n');
  }
}

module.exports = {
  debug: (event, fields) => emit('debug', event, fields),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
