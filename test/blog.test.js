/**
 * The Grain Journal: public reads hide drafts, writes need admin/staff, staff
 * can only change their own posts, slugs stay unique, one featured post.
 */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { db, mockRes } = require('./helpers/setup');
const app = require('../index');
const blog = require('../controllers/blogController');

const ADMIN = { uid: 'admin-1', name: 'Admin', role: 'admin' };
const STAFF = { uid: 'staff-1', name: 'Priya', role: 'staff' };
const OTHER_STAFF = { uid: 'staff-2', name: 'Ravi', role: 'staff' };

const draft = (over = {}) => ({
  title: 'Millets 101', excerpt: 'A beginner guide.', category: 'Super grains',
  content: 'First paragraph.\n\n## Heading\n- one\n- two', ...over,
});

const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };

let server;
let base;
before(async () => {
  server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => db.reset());

test('public list shows only published posts, newest first, without body', async () => {
  await call(blog.createPost, { user: ADMIN, body: draft({ title: 'Old', status: 'published', date: '2026-01-01' }) });
  await call(blog.createPost, { user: ADMIN, body: draft({ title: 'New', status: 'published', date: '2026-02-01' }) });
  await call(blog.createPost, { user: ADMIN, body: draft({ title: 'Hidden draft' }) });

  const r = await fetch(`${base}/api/blog`);
  assert.equal(r.status, 200);
  const { data } = await r.json();
  assert.deepEqual(data.map((p) => p.title), ['New', 'Old']);
  assert.equal(data[0].content, undefined);
});

test('a draft is not readable by slug; a published post is', async () => {
  const d = await call(blog.createPost, { user: ADMIN, body: draft({ title: 'Secret plan' }) });
  assert.equal((await fetch(`${base}/api/blog/${d.body.data.slug}`)).status, 404);

  const p = await call(blog.createPost, { user: ADMIN, body: draft({ title: 'Ragi malt', status: 'published' }) });
  const r = await fetch(`${base}/api/blog/${p.body.data.slug}`);
  assert.equal(r.status, 200);
  assert.match((await r.json()).data.content, /## Heading/);
});

test('writes without a session are rejected', async () => {
  const r = await fetch(`${base}/api/blog`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft()),
  });
  assert.equal(r.status, 401);
  assert.equal((await fetch(`${base}/api/blog/manage/all`)).status, 401);
});

test('slugs are unique and read time is computed', async () => {
  const a = await call(blog.createPost, { user: ADMIN, body: draft() });
  const b = await call(blog.createPost, { user: STAFF, body: draft() });
  assert.equal(a.body.data.slug, 'millets-101');
  assert.equal(b.body.data.slug, 'millets-101-2');
  assert.equal(a.body.data.readMins, 1);
  assert.equal(b.body.data.author, 'Priya');
  assert.equal(b.body.data.status, 'draft');
});

test('staff can edit and delete only their own posts; admin can do any', async () => {
  const mine = await call(blog.createPost, { user: STAFF, body: draft() });
  const id = mine.body.data.id;

  const blocked = await call(blog.updatePost, { user: OTHER_STAFF, params: { id }, body: { title: 'Hijack' } });
  assert.equal(blocked.statusCode, 403);
  assert.equal((await call(blog.deletePost, { user: OTHER_STAFF, params: { id } })).statusCode, 403);

  const ok = await call(blog.updatePost, { user: STAFF, params: { id }, body: { status: 'published' } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await call(blog.updatePost, { user: ADMIN, params: { id }, body: { excerpt: 'Edited' } })).statusCode, 200);
  assert.equal((await call(blog.deletePost, { user: ADMIN, params: { id } })).statusCode, 200);
});

test('featuring a post un-features the previous one', async () => {
  const a = await call(blog.createPost, { user: ADMIN, body: draft({ title: 'A', featured: true, status: 'published' }) });
  await call(blog.createPost, { user: ADMIN, body: draft({ title: 'B', featured: true, status: 'published' }) });
  const { data } = await call(blog.listAll, { user: ADMIN }).then((r) => r.body);
  const featured = data.filter((p) => p.featured).map((p) => p.title);
  assert.deepEqual(featured, ['B']);
  assert.ok(data.find((p) => p.id === a.body.data.id));
});
