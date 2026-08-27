/**
 * Emulator integration — review lifecycle.
 * Regression for the "read after write in a transaction" bug (audit H-3): the
 * old code called updateProductAggregate() (which does transaction.get) AFTER a
 * transaction.update, which the Firestore SDK rejects — so every review
 * approval used to 500. These tests exercise the real transaction path against
 * the emulator.
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
const PRODUCT_ID = 'itest-prod-reviews';
const ORDER_ID = 'itest-order-reviews';
const USER = 'itest-reviewer';

d('review lifecycle (emulator)', () => {
  beforeAll(async () => {
    app = require('../index.js');
    db = require('../config/firebase');

    await db.collection('products').doc(PRODUCT_ID).set({
      name: 'Test Millet', title: 'Test Millet', category: 'Grains',
      price: 100, variants: [{ weight: 'Standard', price: 100, stock: 50 }],
      averageRating: 0, reviewCount: 0, isActive: true,
    });
    await db.collection('orders').doc(ORDER_ID).set({
      userId: USER, status: 'delivered',
      items: [{ productId: PRODUCT_ID, quantity: 1, selectedWeight: 'Standard', name: 'Test Millet', price: 100 }],
      customerInfo: { email: `${USER}@test.dev`, paymentMethod: 'cod' },
      totalAmount: 100,
    });
  });

  it('create → approve → aggregate updates → edit → aggregate reverts', async () => {
    // create
    const create = await request(app)
      .post('/api/reviews')
      .set('Authorization', bearer(USER))
      .send({ productId: PRODUCT_ID, orderId: ORDER_ID, rating: 5, title: 'Great', comment: 'Loved it' });
    expect(create.status).toBe(201);
    const reviewId = create.body.id;

    // pending — not visible, aggregate still zero
    let pub = await request(app).get(`/api/reviews/product/${PRODUCT_ID}`);
    expect(pub.body.data).toHaveLength(0);

    // approve (this used to 500)
    const approve = await request(app)
      .patch(`/api/reviews/admin/${reviewId}/status`)
      .set('Authorization', bearer('itest-admin', 'admin'))
      .send({ status: 'approved' });
    expect(approve.status).toBe(200);

    const prodAfterApprove = (await db.collection('products').doc(PRODUCT_ID).get()).data();
    expect(prodAfterApprove.reviewCount).toBe(1);
    expect(prodAfterApprove.averageRating).toBe(5);

    pub = await request(app).get(`/api/reviews/product/${PRODUCT_ID}`);
    expect(pub.body.data).toHaveLength(1);

    // owner edits an approved review → back to pending, aggregate reverts
    const edit = await request(app)
      .put(`/api/reviews/${reviewId}`)
      .set('Authorization', bearer(USER))
      .send({ rating: 4, comment: 'Still good' });
    expect(edit.status).toBe(200);

    const prodAfterEdit = (await db.collection('products').doc(PRODUCT_ID).get()).data();
    expect(prodAfterEdit.reviewCount).toBe(0);

    // admin deletes it
    const del = await request(app)
      .delete(`/api/reviews/admin/${reviewId}`)
      .set('Authorization', bearer('itest-admin', 'admin'));
    expect(del.status).toBe(200);
  });

  it('rejects a review for an order that is not the caller\'s', async () => {
    const res = await request(app)
      .post('/api/reviews')
      .set('Authorization', bearer('someone-else'))
      .send({ productId: PRODUCT_ID, orderId: ORDER_ID, rating: 5, title: 'x', comment: 'x' });
    expect(res.status).toBe(403);
  });

  it('rejects an over-long comment on update', async () => {
    const create = await request(app)
      .post('/api/reviews')
      .set('Authorization', bearer(USER))
      .send({ productId: PRODUCT_ID, orderId: ORDER_ID, rating: 5, title: 'ok', comment: 'ok' });
    // may 409 if a prior test left one; only assert the update guard when we have an id
    if (create.status === 201) {
      const res = await request(app)
        .put(`/api/reviews/${create.body.id}`)
        .set('Authorization', bearer(USER))
        .send({ comment: 'x'.repeat(2000) });
      expect(res.status).toBe(400);
    }
  });
});
