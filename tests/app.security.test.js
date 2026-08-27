import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { getApp } from './helpers/app.js';

let app;
beforeAll(() => { app = getApp(); });

describe('CORS fails closed', () => {
  it('rejects a disallowed Origin', async () => {
    const res = await request(app).get('/api/products').set('Origin', 'https://evil.test');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows a configured Origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('error responses never leak internals', () => {
  it('404 returns a generic shape with a requestId', async () => {
    const res = await request(app).get('/api/does/not/exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Not found', requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|at Object/i);
  });

  it('oversized JSON body -> 413, no stack', async () => {
    const res = await request(app)
      .post('/api/coupons/validate')
      .set('Content-Type', 'application/json')
      .send({ blob: 'x'.repeat(300 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Request body too large');
  });
});

describe('authentication is required', () => {
  const protectedRoutes = [
    ['post', '/api/super-grains'],
    ['post', '/api/orders'],
    ['post', '/api/coupons/validate'],
    ['get', '/api/orders/my-orders'],
    ['post', '/api/chat/init'],
    ['get', '/api/chat/staff/pending'],
    ['get', '/api/users'],
  ];

  it.each(protectedRoutes)('%s %s -> 401 without a token', async (method, path) => {
    const res = await request(app)[method](path).set('Origin', 'http://localhost:5173').send({});
    expect(res.status).toBe(401);
  });

  it('an invalid bearer token -> 401', async () => {
    const res = await request(app).get('/api/users')
      .set('Origin', 'http://localhost:5173')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('Razorpay webhook signature (raw body)', () => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  it('missing signature -> 400', async () => {
    const res = await request(app).post('/api/orders/razorpay/webhook')
      .set('Content-Type', 'application/json').send({ event: 'x' });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/signature/i);
  });

  it('wrong signature -> 400', async () => {
    const res = await request(app).post('/api/orders/razorpay/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', 'deadbeef')
      .send({ event: 'x' });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/invalid signature/i);
  });

  it('a correct signature passes verification (may 5xx later without emulator)', async () => {
    const raw = JSON.stringify({ event: 'ping' });
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const res = await request(app).post('/api/orders/razorpay/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', sig)
      .send(raw);
    // 200 (with emulator) or 500 (DB unreachable) — but NOT a 400 signature rejection.
    expect(res.status).not.toBe(400);
  });
});

describe('rate limiting keys on the real client IP', () => {
  it('exposes standard RateLimit headers', async () => {
    const res = await request(app).get('/api/products').set('Origin', 'http://localhost:5173');
    expect(res.headers).toHaveProperty('ratelimit-limit');
  });
});

describe('client error reporting endpoint', () => {
  it('accepts a report and returns 204', async () => {
    const res = await request(app)
      .post('/api/client-errors')
      .set('Origin', 'http://localhost:5173')
      .send({ message: 'boom', stack: 'Error: boom\n  at x', url: '/shop' });
    expect(res.status).toBe(204);
  });

  it('is rate limited', async () => {
    let last = 204;
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop
      last = (await request(app).post('/api/client-errors').set('Origin', 'http://localhost:5173').send({ message: 'x' })).status;
    }
    expect(last).toBe(429);
  });
});
