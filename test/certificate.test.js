/** FSSAI certificate: lead-gated download + leads tagged for Admin → Leads. */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db, mockRes } = require('./helpers/setup');
const cert = require('../controllers/certificateController');
const catalogue = require('../controllers/catalogueController');

const BUNDLED = fs.readFileSync(path.join(__dirname, '..', 'assets', 'documents', 'FSSAI-Certificate.pdf'));
const req = (extra = {}) => ({ id: 'r', ip: '::1', get: () => 'test-agent', query: {}, body: {}, ...extra });

function capture() {
  const res = mockRes();
  res.end = (buf) => { res.sent = buf; return res; };
  return res;
}

const tokenFrom = (url) => decodeURIComponent(new URL(url, 'http://x').searchParams.get('token'));

beforeEach(() => db.reset());

test('bundled certificate is a real PDF and the public info shows the registration number', async () => {
  assert.equal(BUNDLED.toString('ascii', 0, 5), '%PDF-');
  const res = mockRes();
  await cert.getInfo(req(), res);
  assert.equal(res.body.data.available, true);
  assert.equal(res.body.data.registrationNo, '22424551000152');
  assert.equal(res.body.data.size, BUNDLED.length);
});

test('name + mobile are required before a download link is issued', async () => {
  for (const body of [{ name: '', mobile: '9876543210' }, { name: 'Asha', mobile: '12345' }, { name: '<script>', mobile: '9876543210' }]) {
    const res = mockRes();
    await cert.submitLead(req({ body }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(db.list('catalogueLeads').length, 0);
});

test('a valid lead is saved as an fssai lead and its link downloads the certificate', async () => {
  const res = mockRes();
  await cert.submitLead(req({ body: { name: 'Asha  K', mobile: '+91 98765 43210' } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));

  const [lead] = db.list('catalogueLeads');
  assert.equal(lead.name, 'Asha K');
  assert.equal(lead.mobile, '9876543210');
  assert.equal(lead.document, 'fssai');

  const dl = capture();
  await cert.downloadFile(req({ query: { token: tokenFrom(res.body.data.downloadUrl) } }), dl);
  assert.equal(dl.headers['Content-Type'], 'application/pdf');
  assert.ok(Buffer.compare(dl.sent, BUNDLED) === 0);
  assert.match(dl.headers['Content-Disposition'], /attachment; filename="Alimenture-FSSAI-Certificate.pdf"/);
});

test('the file cannot be fetched without a token, with a forged one, or with a catalogue token', async () => {
  for (const token of [undefined, 'abc.def', catalogue._internals.makeToken('auto')]) {
    const res = capture();
    await cert.downloadFile(req({ query: { token } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.sent, undefined);
  }
});

test('admin can disable the download; Admin → Leads shows the document type', async () => {
  const off = mockRes();
  await cert.updateDetails(req({ user: { uid: 'a', email: 'a@x.in', role: 'admin' }, body: { enabled: false } }), off);
  assert.equal(off.statusCode, 200);
  const res = mockRes();
  await cert.submitLead(req({ body: { name: 'Ravi', mobile: '9876543210' } }), res);
  assert.equal(res.statusCode, 404);

  db.seed('catalogueLeads/a', { name: 'Old', mobile: '9876500000', createdAt: new Date() });
  db.seed('catalogueLeads/b', { name: 'Cert', mobile: '9876511111', document: 'fssai', createdAt: new Date() });
  const list = mockRes();
  await catalogue.listLeads(req(), list);
  const byName = Object.fromEntries(list.body.data.map((l) => [l.name, l.document]));
  assert.deepEqual(byName, { Old: 'catalogue', Cert: 'fssai' });

  // re-enable for later tests (the controller caches its settings briefly)
  await cert.updateDetails(req({ user: { uid: 'a', email: 'a@x.in', role: 'admin' }, body: { enabled: true } }), mockRes());
});

test('registration number and date are validated on update', async () => {
  const user = { uid: 'a', email: 'a@x.in', role: 'admin' };
  const bad = mockRes();
  await cert.updateDetails(req({ user, body: { registrationNo: '123' } }), bad);
  assert.equal(bad.statusCode, 400);
  const ok = mockRes();
  await cert.updateDetails(req({ user, body: { registrationNo: '22424551000152', validUpto: '2029-03-31' } }), ok);
  assert.equal(ok.statusCode, 200);
});
