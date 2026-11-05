/** Parcel box selection + weight maths (packageService). */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./helpers/setup');
const pkg = require('../services/packageService');

const settings = pkg.normaliseSettings({}); // default catalogue BX-S … BX-XL

test('a single small pack goes in the small box, not a 1 kg-slab box', () => {
  const p = pkg.buildPackage([{ quantity: 1, selectedWeight: '250g', shipWeightKg: 0.27, dims: { l: 14, b: 10, h: 4 } }], settings);
  assert.equal(p.boxId, 'BX-S');
  assert.deepEqual([p.length, p.breadth, p.height], [15, 12, 8]);
  // 0.27 contents + 0.06 box + 0.02 packing
  assert.equal(p.weightKg, 0.35);
  assert.equal(p.volumetricKg, 0.29);
  assert.equal(p.chargeableKg, 0.35);
  assert.equal(p.fits, true);
  assert.deepEqual(p.warnings, []);
});

test('heavier carts step up to a box whose weight limit and volume fit', () => {
  const p = pkg.buildPackage([{ quantity: 4, selectedWeight: '500g', shipWeightKg: 0.52, dims: { l: 16, b: 11, h: 5 } }], settings);
  // 2.08 kg contents > Medium's 1.5 kg limit → Large
  assert.equal(p.boxId, 'BX-L');
  assert.equal(p.weightKg, 2.28);
});

test('an item longer than a box side skips that box', () => {
  const p = pkg.buildPackage([{ quantity: 1, shipWeightKg: 0.2, dims: { l: 25, b: 5, h: 5 } }], settings);
  assert.equal(p.boxId, 'BX-L'); // 25 cm does not fit S (15) or M (22)
});

test('label weight + pouch allowance is used when a variant has no packed weight', () => {
  const p = pkg.buildPackage([{ quantity: 2, selectedWeight: '500g' }], settings);
  assert.equal(p.contentsKg, 1.05); // 2 × 0.5 × 1.05
  assert.equal(p.boxId, 'BX-M');
  assert.ok(p.warnings.some((w) => /no packed weight/.test(w)));
  assert.ok(p.warnings.some((w) => /weight only/.test(w)));
});

test('contents bigger than every box fall back to the largest and are flagged', () => {
  const p = pkg.buildPackage([{ quantity: 30, selectedWeight: '1kg', shipWeightKg: 1.02 }], settings);
  assert.equal(p.boxId, 'BX-C20');
  assert.equal(p.fits, false);
  assert.equal(p.oversize, true);
  assert.ok(p.warnings.some((w) => /largest box/.test(w)));
});

test('staff can force a box or enter a custom size and weight', () => {
  const items = [{ quantity: 1, shipWeightKg: 0.3 }];
  const forced = pkg.buildPackage(items, settings, { boxId: 'bx-m' });
  assert.equal(forced.boxId, 'BX-M');
  assert.equal(forced.source, 'manual');

  const custom = pkg.buildPackage(items, settings, { length: 18, breadth: 12, height: 6, weightKg: 0.45 });
  assert.equal(custom.boxId, null);
  assert.deepEqual([custom.length, custom.breadth, custom.height, custom.weightKg], [18, 12, 6, 0.45]);

  assert.throws(() => pkg.buildPackage(items, settings, { boxId: 'NOPE' }), { code: 'BAD_BOX' });
});

test('inactive boxes are skipped; with none active the env fallback box is used', () => {
  const noSmall = pkg.normaliseSettings({ boxes: pkg.DEFAULT_BOXES.map((b) => ({ ...b, isActive: b.id !== 'BX-S' })) });
  assert.equal(pkg.buildPackage([{ quantity: 1, shipWeightKg: 0.2 }], noSmall).boxId, 'BX-M');

  const none = pkg.normaliseSettings({ boxes: [] });
  const p = pkg.buildPackage([{ quantity: 1, shipWeightKg: 0.2 }], none);
  assert.equal(p.boxId, null);
  assert.deepEqual([p.length, p.breadth, p.height], [20, 15, 10]);
});

test('saving settings rejects bad boxes instead of dropping them silently', () => {
  assert.throws(() => pkg.normaliseSettings({ boxes: [{ id: 'A', length: 10, breadth: 0, height: 5 }] }, { strict: true }), { code: 'BAD_PACKAGE' });
  assert.throws(() => pkg.normaliseSettings({ boxes: [
    { id: 'A', length: 10, breadth: 10, height: 5 },
    { id: 'a', length: 12, breadth: 10, height: 5 },
  ] }, { strict: true }), /used twice/);
});

test('variant shipping fields are validated and normalised', () => {
  assert.equal(pkg.validateVariantShipping({ weight: '1kg', shipWeightKg: 1.05, dims: { l: 20, b: 14, h: 6 } }), null);
  assert.match(pkg.validateVariantShipping({ weight: '1kg', dims: { l: 20, b: '', h: 6 } }), /all three/);
  assert.match(pkg.validateVariantShipping({ weight: '1kg', shipWeightKg: -1 }), /Packed weight/);

  const v = pkg.normaliseVariantShipping({ weight: '1kg', shipWeightKg: '1.05', dims: { l: '20', b: '14', h: '6' } });
  assert.deepEqual([v.shipWeightKg, v.dims], [1.05, { l: 20, b: 14, h: 6 }]);
  const empty = pkg.normaliseVariantShipping({ weight: '1kg', shipWeightKg: '', dims: { l: '', b: '', h: '' } });
  assert.ok(!('shipWeightKg' in empty) && !('dims' in empty));
});

test('parseOverride validates staff input', () => {
  assert.equal(pkg.parseOverride({}), null);
  assert.deepEqual(pkg.parseOverride({ boxId: 'BX-M' }), { boxId: 'BX-M' });
  assert.throws(() => pkg.parseOverride({ length: 10, breadth: 10 }), { code: 'BAD_PACKAGE' });
  assert.throws(() => pkg.parseOverride({ weightKg: 500 }), { code: 'BAD_PACKAGE' });
});

test('admin box catalogue endpoints save, reject bad input and preview an order parcel', async () => {
  const { db, mockRes } = require('./helpers/setup');
  const ctrl = require('../controllers/shippingController');
  db.reset();
  const user = { uid: 'a1', email: 'admin@example.com', role: 'admin' };

  const bad = mockRes();
  await ctrl.updatePackaging({ body: { boxes: [{ id: 'X', length: 10 }] }, user, ip: '::1', id: 'r' }, bad);
  assert.equal(bad.statusCode, 400);

  const ok = mockRes();
  await ctrl.updatePackaging({ body: { boxes: [{ id: 'pouch-mailer', name: 'Mailer', length: 25, breadth: 18, height: 3, boxWeightKg: 0.03, maxWeightKg: 1 }] }, user, ip: '::1', id: 'r' }, ok);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.boxes[0].id, 'POUCH-MAILER');

  db.seed('orders/o1', { status: 'pending', items: [{ productId: 'p', selectedWeight: '250g', quantity: 1, shipWeightKg: 0.26, dims: { l: 20, b: 14, h: 2 } }] });
  const prev = mockRes();
  await ctrl.getPackage({ params: { id: 'o1' }, query: {}, user, id: 'r' }, prev);
  assert.equal(prev.statusCode, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.data.boxId, 'POUCH-MAILER');
  assert.equal(prev.body.data.weightKg, 0.31);

  const unknown = mockRes();
  await ctrl.getPackage({ params: { id: 'o1' }, query: { boxId: 'NOPE' }, user, id: 'r' }, unknown);
  assert.equal(unknown.statusCode, 400);
});
