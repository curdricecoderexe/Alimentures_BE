const test = require('node:test');
const assert = require('node:assert/strict');
const memoCache = require('../lib/memoCache');
const responseCache = require('../middlewares/responseCache');

test('memoCache: serves from memory within the TTL and reloads after clear()', async () => {
  const cache = memoCache({ ttlMs: 60_000 });
  let loads = 0;
  const loader = async () => { loads += 1; return loads; };
  assert.equal(await cache.get('k', loader), 1);
  assert.equal(await cache.get('k', loader), 1);
  cache.clear();
  assert.equal(await cache.get('k', loader), 2);
});

test('memoCache: concurrent misses share one load', async () => {
  const cache = memoCache({ ttlMs: 60_000 });
  let loads = 0;
  const loader = () => new Promise((r) => setTimeout(() => r(++loads), 10));
  const [a, b, c] = await Promise.all([cache.get('k', loader), cache.get('k', loader), cache.get('k', loader)]);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  assert.equal(loads, 1);
});

test('memoCache: a failed reload serves the stale value; a first failure throws', async () => {
  const cache = memoCache({ ttlMs: 0 });
  await cache.get('k', async () => 'old');
  assert.equal(await cache.get('k', async () => { throw new Error('quota'); }), 'old');
  await assert.rejects(cache.get('other', async () => { throw new Error('quota'); }), /quota/);
});

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('responseCache: caches successful GET JSON by URL, not errors', () => {
  const mw = responseCache(60_000);
  const req = { method: 'GET', originalUrl: '/api/analytics/overview?range=7d' };
  let handled = 0;
  const run = (body, status = 200) => {
    const res = fakeRes();
    mw(req, res, () => { handled += 1; res.status(status).json(body); });
    return res;
  };
  run({ success: false }, 500);           // error: not cached
  run({ success: true, n: 1 });           // cached
  const third = run({ success: true, n: 2 });
  assert.equal(handled, 2);
  assert.deepEqual(third.body, { success: true, n: 1 });
  assert.equal(third.headers['X-Cache'], 'HIT');
});
