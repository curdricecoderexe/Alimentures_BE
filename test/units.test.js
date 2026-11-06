/** Slugs, the FAQ assistant and email templates. */
'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers/setup');
const { slugify, buildSlugMap } = require('../lib/slug');
const faqBot = require('../services/faqBot');
const { buildOtpEmail, buildOrderEmail, buildWelcomeEmail } = require('../utils/emailTemplates');
const { invalidateProductCache } = require('../controllers/productController');

test('slugify makes stable, readable slugs', () => {
  assert.equal(slugify('TRI-GRAIN GAIN — PREMIUM'), 'tri-grain-gain-premium');
  assert.equal(slugify('Pure Country Sugar (Nattu Sakkarai)'), 'pure-country-sugar-nattu-sakkarai');
  assert.equal(slugify('Café & Crème'), 'cafe-and-creme');
});

test('buildSlugMap keeps the oldest product on the plain slug', () => {
  const map = buildSlugMap([
    { id: 'newer', title: 'Honey', createdAt: { _seconds: 20 } },
    { id: 'Older1', title: 'Honey', createdAt: { _seconds: 10 } },
  ]);
  assert.equal(map.get('Older1'), 'honey');
  assert.equal(map.get('newer'), 'honey-newer');
});

// ── FAQ assistant ────────────────────────────────────────────────────────────
before(() => {
  db.reset();
  invalidateProductCache();
  db.seed('products/coc', { title: 'CLASSIC COCLETS', category: 'Cookies', description: 'Coconut & red millets', secondaryDescription: 'Key Ingredients: Fresh Grated Coconut, Finger Millet (Ragi), Butter.', variants: [{ weight: '120g', price: 95, stock: 5 }], createdAt: { _seconds: 1 } });
  db.seed('products/pen', { title: 'PENTA BITES — ELITE', category: 'Cookies', description: 'Five millets + nuts', secondaryDescription: 'Key Ingredients: Foxtail, Pearl, Hazelnuts, Almonds.', variants: [{ weight: '120g', price: 140, stock: 0 }], createdAt: { _seconds: 2 } });
  db.seed('products/ghee', { title: 'A2 GHEE', category: 'Others', description: 'Slow clarified', variants: [{ weight: '500ml', price: 450, stock: 3 }], createdAt: { _seconds: 3 } });
  db.seed('deliverySettings/global', { defaultDeliveryFee: 70, freeDeliveryEnabled: true, freeDeliveryThreshold: 500, defaultStandardEta: '3–5 business days', serviceByDefault: true });
});

const ask = (q, user = null) => faqBot.answer(q, user);

test('bot answers product details from live data', async () => {
  const a = await ask('price of a2 ghee');
  assert.match(a.reply, /₹450/);
  assert.equal(a.products[0].name, 'A2 Ghee');
});

test('bot nut filter never confuses coconut with nuts', async () => {
  const withNuts = await ask('which cookies have nuts');
  assert.deepEqual(withNuts.products.map((p) => p.name), ['Penta Bites — Elite']);
  const without = await ask('cookies without nuts');
  assert.deepEqual(without.products.map((p) => p.name), ['Classic Coclets']);
  assert.match(without.reply, /don't list nuts|doesn't list nuts/);
  assert.match(without.reply, /pack label/);
});

test('bot reports stock honestly', async () => {
  const a = await ask('penta bites elite');
  assert.match(a.reply, /sold out/i);
});

test('bot policy answers win over delivery / order routing', async () => {
  assert.match((await ask('do you accept cash on delivery')).reply, /Cash on delivery is not offered/);
  assert.match((await ask('can I cancel my order')).reply, /can't be cancelled/);
});

test('bot uses live delivery settings and asks guests to sign in for orders', async () => {
  assert.match((await ask('delivery charges')).reply, /courier partner's rate.*from ₹\d+/s);
  const order = await ask('where is my order');
  assert.match(order.reply, /sign in/i);
});

test('bot hands off what it cannot answer', async () => {
  assert.equal((await ask('what is the weather today')).handoff, true);
});

// ── email templates ──────────────────────────────────────────────────────────
test('OTP email shows each digit and escapes nothing unsafe', () => {
  const m = buildOtpEmail({ purpose: 'login', otp: '482915' });
  for (const d of '482915') assert.ok(m.html.includes(`>${d}</div>`));
  assert.match(m.text, /482915/);
  assert.ok(!m.html.includes('<script'));
});

test('order email escapes customer-controlled text', () => {
  const m = buildOrderEmail({
    order: { items: [{ name: '<img src=x onerror=alert(1)>', quantity: 1, price: 10 }], totalAmount: 10, customerInfo: { name: '<b>x</b>' }, createdAt: new Date() },
    orderId: 'abc12345', kind: 'placed',
  });
  assert.ok(!m.html.includes('<img src=x'));
  assert.ok(m.html.includes('&lt;img src=x'));
});

test('welcome email always carries an unsubscribe link', () => {
  const m = buildWelcomeEmail({ products: [], unsubscribeUrl: 'https://alimenture.in/api/newsletter/unsubscribe?id=x&sig=y' });
  assert.match(m.html, /Unsubscribe/);
  assert.match(m.text, /Unsubscribe: https:\/\/alimenture\.in/);
});
