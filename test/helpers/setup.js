/**
 * setup.js — load backend modules against fakes instead of real services:
 * an in-memory Firestore, a scripted Razorpay client and a no-op mailer.
 * Must be required BEFORE any controller.
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const { FakeFirestore } = require('./fakeFirestore');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
// Empty (not deleted) so a later dotenv.config() can't fill them from .env.
for (const k of ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_PICKUP_LOCATION', 'SHIPROCKET_PICKUP_PINCODE', 'SHIPROCKET_WEBHOOK_TOKEN',
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'NETLIFY_BUILD_HOOK_URL', 'SITE_REBUILD_COMMAND', 'API_PUBLIC_URL', 'CORS_ORIGIN']) process.env[k] = '';
process.env.PORT = '0';
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{}';
process.env.FIREBASE_WEB_API_KEY = 'test-web-key';
process.env.INTERNAL_CRON = 'false';

const db = new FakeFirestore();

// Scripted Razorpay: tests set the behaviour per case.
const razorpayCalls = { ordersCreated: [] };
const razorpayBehaviour = {
  createOrder: async (opts) => ({ id: `order_rzp_${razorpayCalls.ordersCreated.length + 1}`, amount: opts.amount }),
  fetchPayments: async () => ({ items: [] }),
};
class FakeRazorpay {
  constructor() {
    this.orders = {
      create: async (opts) => { razorpayCalls.ordersCreated.push(opts); return razorpayBehaviour.createOrder(opts); },
      fetchPayments: (id) => razorpayBehaviour.fetchPayments(id),
    };
    this.payments = {
      fetch: async (id) => ({ id, method: 'upi', vpa: 'test@upi', status: 'captured' }),
      refund: async (id, opts) => ({ id: `rfnd_${id}`, amount: opts?.amount, status: 'processed' }),
    };
  }
}

const mailsSent = [];
function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
stub(path.join(__dirname, '../../config/firebase.js'), db);
stub('razorpay', FakeRazorpay);
stub(path.join(__dirname, '../../utils/mailer.js'), {
  sendMail: async (to, subject) => { mailsSent.push({ to, subject }); return { success: true }; },
});

/** Minimal Express-like response recorder. */
function mockRes() {
  const res = { statusCode: 200, body: undefined, headers: {}, cookies: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.set = (k, v) => { if (typeof k === 'object') Object.assign(res.headers, k); else res.headers[k] = v; return res; };
  res.cookie = (k, v, o) => { res.cookies[k] = { value: v, options: o }; return res; };
  res.clearCookie = (k) => { res.cookies[k] = { value: '', cleared: true }; return res; };
  res.end = () => res;
  return res;
}

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

module.exports = { db, razorpayCalls, razorpayBehaviour, mailsSent, mockRes, sign };
