/**
 * Emulator integration — object-level authorization (IDOR/BOLA).
 * Includes the audit M-8 regression: a delivery user may only read an order
 * assigned to them.
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

d('object-level authorization (emulator)', () => {
  beforeAll(async () => {
    app = require('../index.js');
    db = require('../config/firebase');

    await db.collection('orders').doc('idor-order-A').set({
      userId: 'owner-A', status: 'processing',
      customerInfo: { email: 'owner-a@test.dev', paymentMethod: 'cod', address: '1 St' },
      items: [], totalAmount: 100,
      deliveryPerson: { uid: 'driver-assigned' },
    });
    await db.collection('addresses').doc('idor-addr-A').set({
      userId: 'owner-A', fullName: 'A', phone: '1234567', street: '1 St', city: 'T', state: 'S', pincode: '12345',
    });
    await db.collection('notifications').doc('idor-notif-A').set({ target: 'owner-A', title: 'x', message: 'x', read: false });
  });

  it('another customer cannot read the order', async () => {
    const res = await request(app).get('/api/orders/idor-order-A').set('Authorization', bearer('intruder'));
    expect(res.status).toBe(403);
  });

  it('the owner can read their own order', async () => {
    const res = await request(app).get('/api/orders/idor-order-A').set('Authorization', bearer('owner-A'));
    expect(res.status).toBe(200);
  });

  it('an unassigned delivery user cannot read the order (M-8)', async () => {
    const res = await request(app).get('/api/orders/idor-order-A').set('Authorization', bearer('driver-other', 'delivery'));
    expect(res.status).toBe(403);
  });

  it('the assigned delivery user can read the order', async () => {
    const res = await request(app).get('/api/orders/idor-order-A').set('Authorization', bearer('driver-assigned', 'delivery'));
    expect(res.status).toBe(200);
  });

  it('another customer cannot update/delete the address', async () => {
    const upd = await request(app).put('/api/addresses/idor-addr-A').set('Authorization', bearer('intruder'))
      .send({ fullName: 'hax', phone: '9999999', street: 'x', city: 'x', state: 'x', pincode: '11111' });
    expect(upd.status).toBe(403);
    const del = await request(app).delete('/api/addresses/idor-addr-A').set('Authorization', bearer('intruder'));
    expect(del.status).toBe(403);
  });

  it('another user cannot mark the notification read', async () => {
    const res = await request(app).put('/api/notifications/idor-notif-A/read').set('Authorization', bearer('intruder'));
    expect(res.status).toBe(403);
  });

  it('a customer cannot reach staff-only order feeds', async () => {
    const res = await request(app).get('/api/orders').set('Authorization', bearer('intruder'));
    expect(res.status).toBe(403);
  });
});
