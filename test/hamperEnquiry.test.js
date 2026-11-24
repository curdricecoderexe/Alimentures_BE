/**
 * Gift-hamper bulk enquiries: public form validates and stores; admin-only list.
 */
'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { db } = require('./helpers/setup');
const app = require('../index');

let server;
let base;
before(async () => {
  server = http.createServer(app).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => db.reset());

const post = (body) => fetch(`${base}/api/hampers/enquiries`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('a valid bulk enquiry is stored as new', async () => {
  const r = await post({ name: 'Meena R', mobile: '+91 98400 12345', quantity: 50, company: 'Acme', branding: true, hamper: 'The Thank-You Box' });
  assert.equal(r.status, 201);
  const snap = await db.collection('hamperEnquiries').get();
  assert.equal(snap.docs.length, 1);
  const e = snap.docs[0].data();
  assert.equal(e.mobile, '9840012345');
  assert.equal(e.status, 'new');
  assert.equal(e.quantity, 50);
});

test('bad mobile, missing quantity and unknown fields are handled', async () => {
  assert.equal((await post({ name: 'Meena', mobile: '12345', quantity: 10 })).status, 400);
  assert.equal((await post({ name: 'Meena', mobile: '9840012345' })).status, 400);
  const r = await post({ name: 'Meena', mobile: '9840012345', quantity: 10, status: 'won', isAdmin: true });
  assert.equal(r.status, 201);
  const e = (await db.collection('hamperEnquiries').get()).docs[0].data();
  assert.equal(e.status, 'new');
  assert.equal(e.isAdmin, undefined);
});

test('listing enquiries requires an admin session', async () => {
  assert.equal((await fetch(`${base}/api/hampers/enquiries`)).status, 401);
});
