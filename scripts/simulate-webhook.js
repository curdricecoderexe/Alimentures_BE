/**
 * simulate-webhook.js — POST a correctly-signed Razorpay webhook to a running
 * API, so you can verify the webhook handler (signature check, event de-dup,
 * order confirmation, dashboard-refund reconciliation) WITHOUT a public tunnel.
 *
 *   node scripts/simulate-webhook.js payment.captured  <razorpayOrderId> <paymentId>
 *   node scripts/simulate-webhook.js refund.processed   <paymentId>      [amountPaise]
 *
 * Env: RAZORPAY_WEBHOOK_SECRET (must match the API), API_BASE (default http://127.0.0.1:3000)
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const crypto = require('crypto');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!SECRET) { console.error('RAZORPAY_WEBHOOK_SECRET is not set'); process.exit(1); }

const [event, a1, a2] = process.argv.slice(2);
if (!event) {
  console.error('usage: node scripts/simulate-webhook.js <payment.captured|refund.processed|refund.created> ...');
  process.exit(1);
}

let payload;
if (event === 'payment.captured') {
  if (!a1) { console.error('need <razorpayOrderId> [paymentId]'); process.exit(1); }
  payload = {
    event,
    payload: { payment: { entity: { id: a2 || `pay_sim_${Date.now()}`, order_id: a1, status: 'captured' } } },
  };
} else if (event === 'refund.processed' || event === 'refund.created') {
  if (!a1) { console.error('need <paymentId> [amountPaise]'); process.exit(1); }
  payload = {
    event,
    payload: { refund: { entity: { id: `rfnd_sim_${Date.now()}`, payment_id: a1, amount: Number(a2) || undefined, status: 'processed' } } },
  };
} else {
  console.error(`unsupported event: ${event}`);
  process.exit(1);
}

const raw = JSON.stringify(payload);
const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const eventId = `evt_sim_${crypto.randomBytes(6).toString('hex')}`;

(async () => {
  const res = await fetch(`${API_BASE}/api/orders/razorpay/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': signature,
      'X-Razorpay-Event-Id': eventId,
    },
    body: raw,
  });
  console.log(`${event} -> ${res.status} ${await res.text()}`);

  // prove idempotency: replay the same event id
  const replay = await fetch(`${API_BASE}/api/orders/razorpay/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature, 'X-Razorpay-Event-Id': eventId },
    body: raw,
  });
  console.log(`replay   -> ${replay.status} ${await replay.text()}  (expected: "Duplicate event ignored")`);

  // prove tamper rejection
  const bad = await fetch(`${API_BASE}/api/orders/razorpay/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'deadbeef' },
    body: raw,
  });
  console.log(`tampered -> ${bad.status} ${await bad.text()}  (expected: 400)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
