import { describe, it, expect } from 'vitest';
import { validate } from '../middlewares/validate.js';
import imageField from '../middlewares/imageField.js';
import { ORDER_TRANSITIONS, LIMITS } from '../config/constants.js';

const run = (mw, req) => new Promise((resolve) => {
  const res = {};
  mw(req, res, (err) => resolve({ err, req }));
});

describe('validate() — whitelisting & coercion', () => {
  const schema = {
    body: {
      name: { type: 'string', required: true, trim: true, max: 10 },
      price: { type: 'number', min: 0 },
      active: { type: 'boolean', default: false },
      method: { type: 'enum', values: ['a', 'b'] },
    },
  };

  it('drops unknown keys (mass-assignment defence)', async () => {
    const { err, req } = await run(validate(schema), { body: { name: 'x', role: 'admin', usedCount: 999 } });
    expect(err).toBeUndefined();
    expect(req.body).toEqual({ name: 'x', active: false });
    expect(req.body.role).toBeUndefined();
  });

  it('rejects missing required field', async () => {
    const { err } = await run(validate(schema), { body: { price: 5 } });
    expect(err?.status).toBe(400);
  });

  it('rejects over-long string', async () => {
    const { err } = await run(validate(schema), { body: { name: 'waytoolongname' } });
    expect(err?.status).toBe(400);
  });

  it('coerces numeric strings and enforces min', async () => {
    const { err, req } = await run(validate(schema), { body: { name: 'ok', price: '12' } });
    expect(err).toBeUndefined();
    expect(req.body.price).toBe(12);
  });

  it('rejects out-of-set enum', async () => {
    const { err } = await run(validate(schema), { body: { name: 'ok', method: 'z' } });
    expect(err?.status).toBe(400);
  });
});

describe('imageField()', () => {
  const mw = imageField(['image']);
  // A real 1x1 transparent PNG (valid magic bytes).
  const ok = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('passes a small png data URI', async () => {
    const { err } = await run(mw, { body: { image: ok } });
    expect(err).toBeUndefined();
  });

  it('rejects bytes that are not really the declared image type', async () => {
    const fake = 'data:image/png;base64,' + Buffer.from('not a png at all').toString('base64');
    const { err } = await run(mw, { body: { image: fake } });
    expect(err?.status).toBe(400);
  });

  it('passes an https url', async () => {
    const { err } = await run(mw, { body: { image: 'https://cdn.example/x.jpg' } });
    expect(err).toBeUndefined();
  });

  it('rejects a non-image mime', async () => {
    const { err } = await run(mw, { body: { image: 'data:text/html;base64,PHNjcmlwdD4=' } });
    expect(err?.status).toBe(400);
  });

  it('rejects an oversized image', async () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((LIMITS.IMAGE_MAX_BYTES + 50000) * 4 / 3));
    const { err } = await run(mw, { body: { image: huge } });
    expect(err?.status).toBe(400);
  });

  it('ignores an absent field', async () => {
    const { err } = await run(mw, { body: {} });
    expect(err).toBeUndefined();
  });
});

describe('order state machine', () => {
  it('is fulfilment-only — never allows cancelled/refunded as a generic target', () => {
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      expect(targets).not.toContain('cancelled');
      expect(targets).not.toContain('refunded');
    }
  });

  it('is forward-only from pending', () => {
    expect(ORDER_TRANSITIONS.pending).toContain('processing');
    expect(ORDER_TRANSITIONS.pending).not.toContain('payment_pending');
  });

  it('terminal states have no outgoing transitions', () => {
    expect(ORDER_TRANSITIONS.delivered).toEqual([]);
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
    expect(ORDER_TRANSITIONS.refunded).toEqual([]);
  });
});
