/**
 * New-order alerts: team email (ORDER_ALERT_EMAILS) and WhatsApp Cloud API
 * templates. fetch is stubbed — no real messages are sent.
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, mailsSent, mockRes, sign } = require('./helpers/setup');
const orders = require('../controllers/orderController');
const whatsapp = require('../services/whatsappService');
const { buildAdminOrderAlert } = require('../utils/emailTemplates');

const USER = { uid: 'u1', role: 'customer', email: 'cust@example.com' };
const WA_ENV = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ADMIN_NUMBERS',
  'WHATSAPP_TEMPLATE_ADMIN_ORDER', 'WHATSAPP_TEMPLATE_CUSTOMER_ORDER', 'WHATSAPP_TEMPLATE_CUSTOMER_STATUS', 'ORDER_ALERT_EMAILS'];
const realFetch = global.fetch;
let waCalls;

const settle = () => new Promise((r) => setTimeout(r, 30)); // alerts are fire-and-forget

beforeEach(() => {
  db.reset();
  mailsSent.length = 0;
  waCalls = [];
  global.fetch = async (url, opts) => {
    waCalls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    return { ok: true, json: async () => ({}) };
  };
  db.seed('products/cookie', {
    name: 'Ragi Cookie', price: 100, stock: 5, isActive: true,
    variants: [{ weight: '120g', price: 100, stock: 5 }],
  });
});
afterEach(() => {
  global.fetch = realFetch;
  for (const k of WA_ENV) delete process.env[k];
});

async function paidOrder(ci = {}) {
  const res = mockRes();
  await orders.createOrder({
    body: {
      items: [{ productId: 'cookie', selectedWeight: '120g', quantity: 2 }],
      customerInfo: { firstName: 'Asha', lastName: 'R', phone: '98765 43210', address: '12 Lake Rd', city: 'Chennai', state: 'Tamil Nadu', pincode: '600002', ...ci },
    },
    user: USER, headers: {}, id: 'req',
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  const { orderId, razorpayOrderId } = res.body;
  const v = mockRes();
  await orders.verifyRazorpay({
    body: { orderId, razorpay_order_id: razorpayOrderId, razorpay_payment_id: 'pay_9', razorpay_signature: sign(process.env.RAZORPAY_KEY_SECRET, `${razorpayOrderId}|pay_9`) },
    user: USER, id: 'req',
  }, v);
  assert.equal(v.statusCode, 200);
  await settle();
  return orderId;
}

test('a paid order emails the team inboxes with the full order', async () => {
  process.env.ORDER_ALERT_EMAILS = 'owner@alimenture.in, packing@alimenture.in, not-an-email';
  await paidOrder();
  const team = mailsSent.find((m) => m.to.includes('owner@alimenture.in'));
  assert.ok(team, 'team email sent');
  assert.equal(team.to, 'owner@alimenture.in,packing@alimenture.in');
  assert.match(team.subject, /New order .* Asha R, Chennai/);
  assert.ok(mailsSent.some((m) => m.to === 'cust@example.com'), 'customer still gets their own email');
});

test('no team email or WhatsApp when nothing is configured', async () => {
  await paidOrder();
  assert.equal(mailsSent.filter((m) => m.to !== 'cust@example.com').length, 0);
  assert.equal(waCalls.length, 0);
});

test('WhatsApp: team numbers get the new-order template, the customer gets a confirmation', async () => {
  Object.assign(process.env, {
    WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123',
    WHATSAPP_ADMIN_NUMBERS: '+91 90000 00001, 9000000002, bad',
    WHATSAPP_TEMPLATE_ADMIN_ORDER: 'new_order_alert', WHATSAPP_TEMPLATE_CUSTOMER_ORDER: 'order_confirmed',
  });
  await paidOrder();
  const admin = waCalls.filter((c) => c.body.template.name === 'new_order_alert');
  assert.deepEqual(admin.map((c) => c.body.to).sort(), ['919000000001', '919000000002']);
  assert.match(admin[0].url, /graph\.facebook\.com\/v\d+\.\d+\/123\/messages$/);
  assert.equal(admin[0].auth, 'Bearer tok');
  const params = admin[0].body.template.components[0].parameters.map((p) => p.text);
  assert.equal(params.length, 7);
  assert.equal(params[2], 'Asha R');
  assert.match(params[4], /Chennai, Tamil Nadu - 600002/);
  assert.match(params[5], /Ragi Cookie 120g x2/);

  const cust = waCalls.find((c) => c.body.template.name === 'order_confirmed');
  assert.equal(cust.body.to, '919876543210');
});

test('WhatsApp status template goes to the customer on shipped, not on internal states', async () => {
  Object.assign(process.env, { WHATSAPP_TOKEN: 'tok', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TEMPLATE_CUSTOMER_STATUS: 'order_status_update' });
  const order = { customerInfo: { firstName: 'Asha', phone: '9876543210' }, shipment: { awb: 'AWB1', courierName: 'Delhivery' } };
  await whatsapp.notifyStatus('abcdefgh1234', order, 'packed');
  assert.equal(waCalls.length, 0);
  await whatsapp.notifyStatus('abcdefgh1234', order, 'shipped');
  const p = waCalls[0].body.template.components[0].parameters.map((x) => x.text);
  assert.deepEqual(p.slice(0, 3), ['Asha', '#EFGH1234', 'shipped']);
  assert.match(p[3], /Delhivery AWB AWB1/);
});

test('phone numbers are normalised to 91XXXXXXXXXX and junk is rejected', () => {
  assert.equal(whatsapp.toWaNumber('+91 98765-43210'), '919876543210');
  assert.equal(whatsapp.toWaNumber('09876543210'), '919876543210');
  assert.equal(whatsapp.toWaNumber('12345'), null);
  assert.equal(whatsapp.toWaNumber('5876543210'), null); // Indian mobiles start 6–9
});

test('team alert email escapes customer-controlled text', () => {
  const { html, text } = buildAdminOrderAlert({
    orderId: 'o123456789',
    order: { totalAmount: 200, items: [{ name: '<b>x</b>', price: 100, quantity: 2 }], customerInfo: { name: '<script>', address: '"><img>', phone: '9876543210' } },
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('"><img>'));
  assert.match(text, /Phone: 9876543210/);
});
