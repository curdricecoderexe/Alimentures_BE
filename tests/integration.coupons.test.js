/**
 * Emulator integration — coupon redemption is race-safe (audit M-3 / H-2).
 * 20 concurrent COD checkouts against a maxUsage:1 coupon must produce exactly
 * one discounted order and leave usedCount === 1.
 *
 *   npx firebase emulators:exec --only firestore "npm test"
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { hasEmulator } from './setup.js';
import { bearer } from './helpers/authMock.js';

vi.mock('../utils/firebaseAuth', () => require('./helpers/authMock').mockModule());

const d = describe.skipIf(!hasEmulator);

let app;
let db;
const PRODUCT_ID = 'itest-prod-coupons';

async function seedCoupon(code, extra = {}) {
  const ref = await db.collection('coupons').add({
    code, discountType: 'flat', discountValue: 50, minOrderValue: 0,
    maxUsage: 1, usedCount: 0, isActive: true, expiresAt: null,
    createdAt: new Date(), ...extra,
  });
  return ref.id;
}

function placeOrder(uid, code) {
  return request(app)
    .post('/api/orders')
    .set('Authorization', bearer(uid, 'customer', `${uid}@test.dev`))
    .send({
      items: [{ productId: PRODUCT_ID, quantity: 1, selectedWeight: 'Standard' }],
      couponCode: code,
      customerInfo: { firstName: 'A', lastName: 'B', address: '1 St', city: 'Town', paymentMethod: 'cod' },
    });
}

d('coupon redemption (emulator)', () => {
  beforeAll(async () => {
    app = require('../index.js');
    db = require('../config/firebase');
    await db.collection('products').doc(PRODUCT_ID).set({
      name: 'Coupon Test', title: 'Coupon Test', category: 'Grains',
      price: 200, variants: [{ weight: 'Standard', price: 200, stock: 100 }],
      totalStock: 100, isActive: true,
    });
  });

  it('20 concurrent COD redemptions of a maxUsage:1 coupon → exactly 1 wins', async () => {
    const code = 'RACE1';
    const couponId = await seedCoupon(code);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => placeOrder(`race-user-${i}`, code)),
    );

    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);

    const coupon = (await db.collection('coupons').doc(couponId).get()).data();
    expect(coupon.usedCount).toBe(1);

    const redemptions = await db.collection('couponRedemptions').where('couponId', '==', couponId).get();
    expect(redemptions.size).toBe(1);

    // the winning order actually carries the discount
    const winnerOrder = (await db.collection('orders').doc(created[0].body.id).get()).data();
    expect(winnerOrder.discountAmount).toBe(50);
    // subtotal 200 + shipping 50 - discount 50 = 200
    expect(winnerOrder.totalAmount).toBe(200);
  });

  it('same user cannot redeem the same coupon twice', async () => {
    const code = 'ONCE1';
    await seedCoupon(code, { maxUsage: 5 });
    const first = await placeOrder('repeat-user', code);
    expect(first.status).toBe(201);
    const second = await placeOrder('repeat-user', code);
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/already used/i);
  });

  it('expired / inactive coupons are not applied', async () => {
    await seedCoupon('EXPIRED1', { expiresAt: new Date(Date.now() - 1000) });
    await seedCoupon('INACTIVE1', { isActive: false });
    for (const code of ['EXPIRED1', 'INACTIVE1', 'NOSUCHCODE']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await placeOrder(`nc-${code}`, code);
      // order still succeeds but with no discount
      expect(res.status).toBe(201);
      // eslint-disable-next-line no-await-in-loop
      const order = (await db.collection('orders').doc(res.body.id).get()).data();
      expect(order.discountAmount).toBe(0);
      expect(order.couponId == null).toBe(true);
    }
  });
});
