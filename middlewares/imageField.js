/**
 * imageField(fields) — validate inline base64 image fields on a request body.
 *
 * Images in this app are stored as `data:` URIs directly inside Firestore
 * documents (1 MB doc ceiling). This middleware enforces:
 *   - the value is a data: URI with an allowed image MIME type
 *   - the decoded byte length is <= LIMITS.IMAGE_MAX_BYTES
 *   - http(s) URLs are also accepted (already-hosted images)
 * Empty / absent values pass through untouched.
 *
 *   router.post('/', imageField(['image', 'secondaryImage']), controller);
 */

'use strict';

const { LIMITS } = require('../config/constants');

const DATA_URI_RE = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  e.expose = true;
  e.publicMessage = message;
  return e;
}

// Magic-byte signatures for the allowed formats.
function sniffImageType(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function checkOne(fieldName, value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw badRequest(`${fieldName} must be a string`);

  // Allow already-hosted images
  if (/^https?:\/\//i.test(value)) {
    if (value.length > 2048) throw badRequest(`${fieldName} URL is too long`);
    return;
  }

  const m = value.match(DATA_URI_RE);
  if (!m) throw badRequest(`${fieldName} must be an https URL or a base64 image data URI`);

  const mime = m[1].toLowerCase();
  if (!LIMITS.IMAGE_MIME_ALLOW.includes(mime)) {
    throw badRequest(`${fieldName} must be a PNG, JPEG or WebP image`);
  }

  const b64 = m[2].replace(/\s/g, '');
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > LIMITS.IMAGE_MAX_BYTES) {
    throw badRequest(`${fieldName} is too large (max ${Math.round(LIMITS.IMAGE_MAX_BYTES / 1024)} KB)`);
  }

  // The bytes must actually be a real image of one of the allowed types, and the
  // real type must match the declared MIME (jpg/jpeg are equivalent).
  let head;
  try {
    head = Buffer.from(b64.slice(0, 32), 'base64');
  } catch {
    throw badRequest(`${fieldName} is not valid base64`);
  }
  const sniffed = sniffImageType(head);
  const declared = mime === 'image/jpg' ? 'image/jpeg' : mime;
  if (!sniffed || sniffed !== declared) {
    throw badRequest(`${fieldName} is not a valid ${declared.replace('image/', '').toUpperCase()} image`);
  }
}

function imageField(fields) {
  const list = Array.isArray(fields) ? fields : [fields];
  return (req, res, next) => {
    try {
      const body = req.body || {};
      for (const f of list) checkOne(f, body[f]);
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = imageField;
