/**
 * Gift Hampers page: admin can hide/show it; the public settings read reports it;
 * the top banner is a known appearance slot.
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, mockRes } = require('./helpers/setup');
const settings = require('../controllers/settingsController');
const { APPEARANCE_KEYS } = require('../config/appearanceSlots');

const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const ADMIN = { uid: 'admin-1', email: 'a@example.com', role: 'admin' };

beforeEach(() => db.reset());

test('hampers visibility toggles and is readable publicly', async () => {
  const hide = await call(settings.updateHampersVisibility, { user: ADMIN, body: { visible: false } });
  assert.equal(hide.statusCode, 200);
  let read = await call(settings.getSettings, {});
  assert.equal(read.body.data.hampersVisible, false);

  await call(settings.updateHampersVisibility, { user: ADMIN, body: { visible: true } });
  read = await call(settings.getSettings, {});
  assert.equal(read.body.data.hampersVisible, true);
});

test('hampers visibility rejects anything but a boolean', async () => {
  for (const visible of ['false', 0, null, undefined]) {
    const r = await call(settings.updateHampersVisibility, { user: ADMIN, body: { visible } });
    assert.equal(r.statusCode, 400, String(visible));
  }
});

test('hiding hampers keeps the other storefront settings', async () => {
  db.seed('settings/storefront', { socialLinks: [{ platform: 'instagram', url: 'https://instagram.com/x', enabled: true }] });
  await call(settings.updateHampersVisibility, { user: ADMIN, body: { visible: false } });
  const read = await call(settings.getSettings, {});
  assert.equal(read.body.data.socialLinks.length, 1);
});

test('the hampers banner is a customisable appearance slot', () => {
  assert.ok(APPEARANCE_KEYS.includes('hampersHero'));
});

test('hamper-page image slots are served only to the hampers page', async () => {
  const { APPEARANCE_SLOTS } = require('../config/appearanceSlots');
  const appearance = require('../controllers/appearanceController');
  const png = 'data:image/png;base64,' + Buffer.from('x').toString('base64');
  db.seed('appearanceAssets/hamper-little-joys', { image: png });
  db.seed('appearanceAssets/featuredBg', { image: png });
  const page = APPEARANCE_SLOTS.filter((s) => s.page === 'hampers').map((s) => s.key);
  assert.ok(page.includes('hampersHero') && page.includes('grainlet-penta-bite') && page.length === 11);

  const site = await call(appearance.getAppearance, { query: {} });
  assert.ok(site.body.data.featuredBg);
  assert.equal(site.body.data['hamper-little-joys'], undefined);
  const hampers = await call(appearance.getAppearance, { query: { page: 'hampers' } });
  assert.ok(hampers.body.data['hamper-little-joys']);
  assert.equal(hampers.body.data.featuredBg, undefined);
});

test('commitment copy saves and validates the pledge count', async () => {
  const ok = await call(settings.updateCommitment, { user: ADMIN, body: { headline: 'Every product counts', highlight: 'healthier India.', pledges: ['A', 'B'] } });
  assert.equal(ok.statusCode, 200);
  const read = await call(settings.getSettings, {});
  assert.deepEqual(read.body.data.commitment.pledges, ['A', 'B']);
  assert.equal(read.body.data.commitment.ctaLink, '/shop');
  const none = await call(settings.updateCommitment, { user: ADMIN, body: { headline: 'x', pledges: [] } });
  assert.equal(none.statusCode, 400);
});
