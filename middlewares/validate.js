/**
 * validate(schema) — dependency-free request validation + whitelisting.
 *
 * A schema describes `body`, `query` and/or `params`. Unknown keys are DROPPED
 * (this is the mass-assignment defence), values are coerced/validated, and the
 * cleaned object replaces the original on `req`.
 *
 *   const schema = {
 *     body: {
 *       name:        { type: 'string', required: true, trim: true, max: 120 },
 *       price:       { type: 'number', min: 0 },
 *       isFeatured:  { type: 'boolean', default: false },
 *       badges:      { type: 'array', maxItems: 20, of: { type: 'string', max: 40 } },
 *       paymentMethod:{ type: 'enum', values: ['cod', 'razorpay'], required: true },
 *     },
 *   };
 *   router.post('/', validate(schema), controller);
 *
 * P1 may swap the internals for zod; the `validate(schema)` call sites stay.
 */

'use strict';

function fail(message) {
  const e = new Error(message);
  e.status = 400;
  e.expose = true;
  e.publicMessage = message;
  return e;
}

function coerceField(key, raw, spec) {
  const isMissing = raw === undefined || raw === null || raw === '';

  if (isMissing) {
    if (spec.required) throw fail(`${key} is required`);
    if ('default' in spec) return spec.default;
    return undefined;
  }

  switch (spec.type) {
    case 'string': {
      if (typeof raw !== 'string') throw fail(`${key} must be a string`);
      let v = spec.trim ? raw.trim() : raw;
      if (spec.trim && v === '' && spec.required) throw fail(`${key} is required`);
      if (spec.max != null && v.length > spec.max) throw fail(`${key} is too long`);
      if (spec.min != null && v.length < spec.min) throw fail(`${key} is too short`);
      if (spec.pattern && !spec.pattern.test(v)) throw fail(`${key} is invalid`);
      return v;
    }
    case 'number':
    case 'integer': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw fail(`${key} must be a number`);
      if (spec.type === 'integer' && !Number.isInteger(n)) throw fail(`${key} must be a whole number`);
      if (spec.min != null && n < spec.min) throw fail(`${key} must be >= ${spec.min}`);
      if (spec.max != null && n > spec.max) throw fail(`${key} must be <= ${spec.max}`);
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return Boolean(raw);
    }
    case 'enum': {
      if (!spec.values.includes(raw)) throw fail(`${key} must be one of: ${spec.values.join(', ')}`);
      return raw;
    }
    case 'array': {
      if (!Array.isArray(raw)) throw fail(`${key} must be an array`);
      if (spec.maxItems != null && raw.length > spec.maxItems) throw fail(`${key} has too many items`);
      if (spec.of) return raw.map((item, i) => coerceField(`${key}[${i}]`, item, spec.of));
      return raw;
    }
    case 'object': {
      if (typeof raw !== 'object' || Array.isArray(raw)) throw fail(`${key} must be an object`);
      if (spec.shape) return validateShape(raw, spec.shape, key + '.');
      return raw;
    }
    case 'any':
    default:
      return raw;
  }
}

function validateShape(source, shape, prefix = '') {
  const out = {};
  const src = source && typeof source === 'object' ? source : {};
  for (const [key, spec] of Object.entries(shape)) {
    const value = coerceField(prefix + key, src[key], spec);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function validate(schema) {
  return (req, res, next) => {
    try {
      for (const part of ['params', 'query', 'body']) {
        if (schema[part]) {
          const cleaned = validateShape(req[part] || {}, schema[part]);
          if (part === 'query') {
            // req.query is a getter-only in Express 5 — mutate in place
            for (const k of Object.keys(req.query)) delete req.query[k];
            Object.assign(req.query, cleaned);
          } else {
            req[part] = cleaned;
          }
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { validate };
