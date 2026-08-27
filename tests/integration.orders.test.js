/**
 * Emulator integration — checkout is server-authoritative.
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
const P = 'itest-prod-orders';
const P_DRAFT = 'itest-prod-draft';

const cod = (items, extra = {}) => ({
  items,
  customerInfo: { firstName: 'A', lastName: 'B', address: '1 St', city: 'Town', paymentMethod: 'cod' },
  ...extra,
});

d('checkout (emulator)', () => {
  beforeAll(async () => {
    app = require('../index.js');
    db = require('../config/firebase');
    await db.collection('products').doc(P).set({
      name: 'Order Test', title: 'Order Test', category: 'Grains',
      price: 300, variants: [{ weight: 'Standard', price: 300, stock: 10 }],
      totalStock: 10, isActive: true,
    });
    await db.collection('products').doc(P_DRAFT).set({
      name: 'Draft', title: 'Draft', isDraft: true, isActive: true,
      variants: [{ weight: 'Standard', price: 10, stock: 10 }],
    });
  });

  it('recomputes price server-side (ignores a client-sent price)', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', bearer('u-price'))
      .send(cod([{ productId: P, quantity: 1, selectedWeight: 'Standard', price: 1 }]));
    expect(res.status).toBe(201);
    const order = (await db.collection('orders').doc(res.body.id).get()).data();
    expect(order.subtotal).toBe(300);
    expect(order.items[0].price).toBe(300); // stored item is rebuilt from the product
  });

  it('rejects quantity out of bounds', async () => {
    const res = await request(app).post('/api/orders').set('Authorization', bearer('u-qty'))
      .send(cod([{ productId: P, quantity: 999, selectedWeight: 'Standard' }]));
    expect(res.status).toBe(400);
  });

  it('rejects a draft product', async () => {
    const res = await request(app).post('/api/orders').set('Authorization', bearer('u-draft'))
      .send(cod([{ productId: P_DRAFT, quantity: 1, selectedWeight: 'Standard' }]));
    expect(res.status).toBe(400);
  });

  it('rejects insufficient stock', async () => {
    const res = await request(app).post('/api/orders').set('Authorization', bearer('u-stock'))
      .send(cod([{ productId: P, quantity: 9999, selectedWeight: 'Standard' }]));
    expect(res.status).toBe(400);
  });

  it('a duplicate Idempotency-Key returns 409', async () => {
    const key = `itest-idem-${Date.now()}`;
    const body = cod([{ productId: P, quantity: 1, selectedWeight: 'Standard' }]);
    const first = await request(app).post('/api/orders').set('Authorization', bearer('u-idem')).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/orders').set('Authorization', bearer('u-idem')).set('Idempotency-Key', key).send(body);
    expect(second.status).toBe(409);
  });

  it('decrements stock transactionally', async () => {
    const before = (await db.collection('products').doc(P).get()).data();
    const beforeStock = before.variants[0].stock;
    const res = await request(app).post('/api/orders').set('Authorization', bearer('u-dec'))
      .send(cod([{ productId: P, quantity: 2, selectedWeight: 'Standard' }]));
    expect(res.status).toBe(201);
    const after = (await db.collection('products').doc(P).get()).data();
    expect(after.variants[0].stock).toBe(beforeStock - 2);
  });
});
