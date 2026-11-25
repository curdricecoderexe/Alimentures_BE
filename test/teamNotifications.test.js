/**
 * Store updates are emailed to the team (ORDER_ALERT_EMAILS) instead of being
 * written to a Firestore-polled bell; customer-targeted calls are no-ops.
 */
'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, mailsSent } = require('./helpers/setup');
const { createNotification, _internal } = require('../controllers/notificationController');

const saved = process.env.ORDER_ALERT_EMAILS;
beforeEach(() => {
  mailsSent.length = 0;
  _internal.recent.clear();
  process.env.ORDER_ALERT_EMAILS = 'team@example.com, ops@example.com';
});
after(() => { process.env.ORDER_ALERT_EMAILS = saved; });

test('admin/staff updates are emailed once to every team inbox', async () => {
  await createNotification('admin', 'Order Status Updated', 'Order #ABC123 is now shipped', { orderId: 'ord_ABC123' });
  await createNotification('staff', 'Order Status Updated', 'Order #ABC123 is now shipped', { orderId: 'ord_ABC123' });
  assert.equal(mailsSent.length, 1, 'same update for admin + staff is sent once');
  assert.equal(mailsSent[0].to, 'team@example.com,ops@example.com');
  assert.match(mailsSent[0].subject, /Order Status Updated/);
});

test('customer-targeted notifications send nothing and write nothing', async () => {
  await createNotification('user_123', 'Order Update', 'Your order is shipped');
  assert.equal(mailsSent.length, 0);
  const snap = await db.collection('notifications').get();
  assert.equal(snap.size, 0);
});

test('no team inbox configured: nothing is sent', async () => {
  process.env.ORDER_ALERT_EMAILS = '';
  await createNotification('admin', 'Shiprocket push failed', 'Order #X failed');
  assert.equal(mailsSent.length, 0);
});
