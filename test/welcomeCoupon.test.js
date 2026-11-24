/**
 * Welcome offer: new customers get one personal 10% code, it is stable,
 * locked to the owner, and disappears after their first order.
 */
'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, mockRes } = require('./helpers/setup');
const coupons = require('../controllers/couponController');

const call = async (fn, req) => { const res = mockRes(); await fn(req, res); return res; };
const ANU = { uid: 'cust-1', role: 'customer' };
const BALA = { uid: 'cust-2', role: 'customer' };

beforeEach(() => db.reset());

test('a new customer gets one stable 10% welcome code', async () => {
  const first = await call(coupons.getWelcomeCoupon, { user: ANU });
  assert.equal(first.statusCode, 200);
  assert.match(first.body.data.code, /^WELCOME10-/);
  assert.equal(first.body.data.discountValue, 10);
  const again = await call(coupons.getWelcomeCoupon, { user: ANU });
  assert.equal(again.body.data.code, first.body.data.code);
});

test('the welcome code only validates for its owner', async () => {
  const { code } = (await call(coupons.getWelcomeCoupon, { user: ANU })).body.data;
  const mine = await call(coupons.validateCoupon, { user: ANU, body: { code, orderValue: 500 } });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.body.discountAmount, 50);
  const theirs = await call(coupons.validateCoupon, { user: BALA, body: { code, orderValue: 500 } });
  assert.equal(theirs.statusCode, 404);
});

test('no welcome offer after a placed order, for staff, or once redeemed', async () => {
  db.seed('orders/o1', { userId: ANU.uid, status: 'pending' });
  assert.equal((await call(coupons.getWelcomeCoupon, { user: ANU })).body.data, null);

  assert.equal((await call(coupons.getWelcomeCoupon, { user: { uid: 's1', role: 'staff' } })).body.data, null);

  const { id } = (await call(coupons.getWelcomeCoupon, { user: BALA })).body.data;
  db.seed(`couponRedemptions/${id}_${BALA.uid}`, { couponId: id, userId: BALA.uid });
  assert.equal((await call(coupons.getWelcomeCoupon, { user: BALA })).body.data, null);
});

test('an unpaid (payment_pending) order does not cancel the offer', async () => {
  db.seed('orders/o2', { userId: ANU.uid, status: 'payment_pending' });
  assert.ok((await call(coupons.getWelcomeCoupon, { user: ANU })).body.data);
});
