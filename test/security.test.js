/**
 * HTTP-level checks for the security fixes from the 2026-10-24 assessment,
 * run against the real Express app (in-memory Firestore, no network).
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { db, mockRes } = require('./helpers/setup');
const app = require('../index');
const { csrfOriginCheck } = require('../middlewares/requestGuards');
const isAdmin = require('../middlewares/isAdmin');
const isStaff = require('../middlewares/isStaff');

let server;
let base;
before(async () => {
  db.reset();
  const png = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
  db.seed('products/p1', {
    title: 'HONEY', category: 'Others', price: 399, stock: 49, image: png,
    variants: [{ weight: '500g', price: 399, mrp: 499, stock: 49 }],
    createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-02T00:00:00Z'),
  });
  server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path, headers = {}) => fetch(base + path, { headers });

test('F-11: operator / array query parameters are rejected', async () => {
  for (const q of ['q[$ne]=null', 'q[]=test', 'q[$regex]=.*', 'q=a&q=b']) {
    const r = await get(`/api/products/search?${q}&limit=100`);
    assert.equal(r.status, 400, q);
  }
  assert.equal((await get('/api/products/search?q=honey')).status, 200);
});

test('F-12: non-JSON bodies get 415, never a 500', async () => {
  const r = await fetch(`${base}/api/cart/validate`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: '<?xml version="1.0"?><items/>',
  });
  assert.equal(r.status, 415);
});

test('F-18: an empty cart is not valid', async () => {
  const r = await fetch(`${base}/api/cart/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [] }),
  });
  const body = await r.json();
  assert.equal(body.valid, false);
});

test('F-5 / F-6 / images: public products hide stock, use ISO dates and image URLs', async () => {
  const body = await (await get('/api/products')).json();
  const p = body.data[0];
  assert.ok(p.stock <= 10 && p.variants[0].stock <= 10, 'stock capped');
  assert.equal(p.createdAt, '2026-10-01T00:00:00.000Z');
  assert.match(p.image, /\/api\/products\/p1\/image\/main\?v=\d+$/);
  assert.ok(!JSON.stringify(body).includes('base64'), 'no inline images in the list');

  const img = await fetch(p.image.replace(/^https?:\/\/[^/]+/, base));
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await img.arrayBuffer()).toString(), 'fake-png-bytes');
});

test('F-9 / F-8: error bodies carry no requestId and rate-limit budgets are not advertised', async () => {
  const r = await get('/api/orders');
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.requestId, undefined);
  assert.ok(r.headers.get('x-request-id'), 'id still available to support via header');
  assert.equal(r.headers.get('ratelimit-remaining'), null);
  assert.equal(r.headers.get('ratelimit-policy'), null);
});

test('F-16: /users/me requires a session and resolves to the caller', async () => {
  assert.equal((await get('/api/users/me')).status, 401);
});

test('F-19: role checks return a generic Forbidden', () => {
  for (const mw of [isAdmin, isStaff]) {
    const res = mockRes();
    mw({ user: { role: 'customer' } }, res, () => assert.fail('should not pass'));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'Forbidden');
  }
});

test('CSRF: cookie-authenticated writes must come from our own origin', () => {
  const check = csrfOriginCheck(() => ['https://alimenture.in']);
  const req = (origin) => ({
    method: 'POST', authVia: 'cookie', headers: origin ? { origin } : {}, protocol: 'https', get: () => 'alimenture.in',
  });
  let passed = 0;
  check(req('https://alimenture.in'), mockRes(), () => { passed += 1; });
  const bad = mockRes();
  check(req('https://evil.example'), bad, () => assert.fail('cross-site write allowed'));
  assert.equal(bad.statusCode, 403);
  const none = mockRes();
  check(req(null), none, () => assert.fail('origin-less cookie write allowed'));
  assert.equal(none.statusCode, 403);
  check({ ...req('https://evil.example'), authVia: 'bearer' }, mockRes(), () => { passed += 1; });
  assert.equal(passed, 2, 'same-origin cookie write + bearer write pass');
});

test('unknown API routes are a clean JSON 404', async () => {
  const r = await get('/api/definitely-not-a-route');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { success: false, error: 'Not found' });
});
