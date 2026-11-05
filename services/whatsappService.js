/**
 * whatsappService.js — order alerts over the WhatsApp Business Cloud API (Meta).
 *
 * OFF unless WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set. Every message is
 * fire-and-forget: a WhatsApp failure is logged and never affects an order.
 *
 * Business-initiated WhatsApp messages must use a TEMPLATE pre-approved in
 * Meta WhatsApp Manager. Each template below is optional — leave its env var
 * empty to skip that message. Body placeholders, in order:
 *
 *   WHATSAPP_TEMPLATE_ADMIN_ORDER      → to WHATSAPP_ADMIN_NUMBERS on every paid order
 *       {{1}} order no.  {{2}} amount  {{3}} customer name  {{4}} phone
 *       {{5}} city, state – PIN  {{6}} items summary  {{7}} delivery method
 *   WHATSAPP_TEMPLATE_CUSTOMER_ORDER   → to the customer when payment succeeds
 *       {{1}} first name  {{2}} order no.  {{3}} amount  {{4}} delivery ETA
 *   WHATSAPP_TEMPLATE_CUSTOMER_STATUS  → to the customer on shipped / out for
 *       delivery / delivered / cancelled / refunded
 *       {{1}} first name  {{2}} order no.  {{3}} status  {{4}} tracking info
 */
'use strict';

const log = require('../lib/logger');

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const TIMEOUT_MS = 8000;

const env = (k) => String(process.env[k] || '').trim();
const isEnabled = () => !!(env('WHATSAPP_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID'));
const lang = () => env('WHATSAPP_TEMPLATE_LANG') || 'en';

const shortId = (id) => `#${String(id || '').slice(-8).toUpperCase()}`;
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** Indian mobile → "91XXXXXXXXXX", or null. Accepts +91 / 0 prefixes and spaces. */
function toWaNumber(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2)
    : d.length === 11 && d.startsWith('0') ? d.slice(1)
      : d;
  return /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
}

/** Template params may not contain newlines/tabs or 4+ spaces, and must be non-empty. */
function param(v, max = 200) {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, max);
  return { type: 'text', text: s || '-' };
}

async function sendTemplate(to, name, params) {
  if (!isEnabled() || !name || !to) return { skipped: true };
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${env('WHATSAPP_PHONE_NUMBER_ID')}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('WHATSAPP_TOKEN')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name,
          language: { code: lang() },
          components: [{ type: 'body', parameters: params.map((p) => param(p)) }],
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      log.warn('whatsapp.send_failed', { template: name, status: res.status, error: body?.error?.message });
      return { ok: false };
    }
    log.info('whatsapp.sent', { template: name });
    return { ok: true };
  } catch (err) {
    log.warn('whatsapp.send_failed', { template: name, err });
    return { ok: false };
  }
}

const adminNumbers = () => env('WHATSAPP_ADMIN_NUMBERS').split(',').map(toWaNumber).filter(Boolean);
const firstName = (ci = {}) => ci.firstName || String(ci.name || '').split(' ')[0] || 'there';

function itemsSummary(items = []) {
  const parts = items.map((it) => `${it.name}${it.selectedWeight ? ` ${it.selectedWeight}` : ''} x${Number(it.quantity) || 1}`);
  const s = parts.join(', ');
  return s.length > 180 ? `${s.slice(0, 177)}...` : s;
}

/** New paid order → shop team (+ customer confirmation when in stock). Never throws. */
async function notifyPaidOrder(orderId, order, { inStock = true } = {}) {
  if (!isEnabled()) return;
  const ci = order.customerInfo || {};
  const jobs = [];
  const adminTpl = env('WHATSAPP_TEMPLATE_ADMIN_ORDER');
  if (adminTpl) {
    const params = [
      shortId(orderId) + (inStock ? '' : ' (OUT OF STOCK - refund needed)'),
      money(order.totalAmount),
      ci.name || firstName(ci),
      ci.phone || '-',
      `${[ci.city, ci.state].filter(Boolean).join(', ')} - ${ci.pincode || ''}`,
      itemsSummary(order.items),
      `${order.deliveryMethod === 'fastest' ? 'Fastest' : 'Standard'}${order.deliveryPartner === 'local' ? ' (local partner)' : ''}`,
    ];
    for (const to of adminNumbers()) jobs.push(sendTemplate(to, adminTpl, params));
  }
  const custTpl = env('WHATSAPP_TEMPLATE_CUSTOMER_ORDER');
  const custTo = toWaNumber(ci.phone);
  if (custTpl && custTo && inStock) {
    jobs.push(sendTemplate(custTo, custTpl, [firstName(ci), shortId(orderId), money(order.totalAmount), order.deliveryEstimate || '3-5 business days']));
  }
  await Promise.allSettled(jobs);
}

const STATUS_TEXT = {
  shipped: 'shipped',
  out_for_delivery: 'out for delivery',
  delivered: 'delivered',
  cancelled: 'cancelled',
  refunded: 'refunded',
};

/** Order status change → customer. Only the statuses above are sent. Never throws. */
async function notifyStatus(orderId, order, status) {
  const tpl = env('WHATSAPP_TEMPLATE_CUSTOMER_STATUS');
  const label = STATUS_TEXT[String(status || '').toLowerCase()];
  const to = toWaNumber(order?.customerInfo?.phone);
  if (!isEnabled() || !tpl || !label || !to) return;
  const sh = order.shipment || {};
  const tracking = sh.awb
    ? `${sh.courierName || 'Courier'} AWB ${sh.awb} - ${sh.trackUrl || `https://shiprocket.co/tracking/${sh.awb}`}`
    : 'See My Orders on alimenture.in';
  await sendTemplate(to, tpl, [firstName(order.customerInfo), shortId(orderId), label, tracking]);
}

module.exports = { isEnabled, toWaNumber, notifyPaidOrder, notifyStatus, _sendTemplate: sendTemplate };
