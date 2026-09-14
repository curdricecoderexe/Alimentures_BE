/**
 * emailTemplates.js — branded, responsive (table-based) transactional emails
 * for the Alimenture storefront. One builder, `buildOrderEmail`, produces
 * { subject, text, html, attachments } for every order lifecycle event.
 *
 * Product images are stored as base64 data URLs in Firestore; email clients
 * (Gmail especially) refuse to render `data:` URIs in the body, so each image
 * is attached inline and referenced via `cid:`.
 */
'use strict';

const crypto = require('crypto');

const BRAND = {
  berry: '#A50D5A',
  berryDeep: '#79083F',
  gold: '#D7A94E',
  goldTint: '#F9F1E1',
  cream: '#FBF7EF',
  creamDeep: '#F4EBDA',
  ink: '#221B1F',
  inkSoft: '#5A4F55',
  muted: '#8E848B',
  line: '#EEE6D6',
  leaf: '#2E7D51',
  paper: '#FFFFFF',
};

const SITE_URL = (process.env.DOMAIN || process.env.CORS_ORIGIN || 'https://alimenture.in')
  .split(',')[0].trim().replace(/\/$/, '');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

const shortId = (id) => `#${String(id || '').slice(-8).toUpperCase()}`;

const fmtDate = (ts) => {
  const d = ts?.toDate ? ts.toDate() : ts?._seconds ? new Date(ts._seconds * 1000) : ts ? new Date(ts) : new Date();
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
};

/** data:image/png;base64,xxxx  ->  nodemailer inline attachment (or null) */
function imageAttachment(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z.+-]+);base64,(.+)$/);
  if (!m) return null;
  const [, contentType, b64] = m;
  const content = Buffer.from(b64, 'base64');
  if (content.length > 3_000_000) return null; // don't attach absurdly large images
  const ext = (contentType.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  const cid = `img_${crypto.randomBytes(8).toString('hex')}@alimenture`;
  return { filename: `product.${ext}`, content, contentType, cid, contentDisposition: 'inline' };
}

const EVENTS = {
  placed: {
    emoji: '🧾',
    subjectPrefix: 'Order placed',
    heading: 'Your order is in',
    blurb: "Thanks for shopping clean. We've received your order and will start packing it shortly.",
  },
  paid: {
    emoji: '✅',
    subjectPrefix: 'Payment confirmed',
    heading: 'Payment received',
    blurb: 'Your payment went through and your order is confirmed. Packing begins now.',
  },
  status: {
    emoji: '📦',
    subjectPrefix: 'Order update',
    heading: 'Order update',
    blurb: 'Here is the latest on your order.',
  },
  delivered: {
    emoji: '🎉',
    subjectPrefix: 'Delivered',
    heading: 'Delivered — enjoy!',
    blurb: 'Your order has been delivered. Your GST invoice is attached to this email as a PDF.',
  },
  cancelled: {
    emoji: '⚠️',
    subjectPrefix: 'Order cancelled',
    heading: 'Order cancelled',
    blurb: 'This order has been cancelled. Any payment made will be refunded to your original method.',
  },
  refunded: {
    emoji: '↩️',
    subjectPrefix: 'Refund processed',
    heading: 'Refund on its way',
    blurb: 'We have processed your refund. Banks usually take 3–7 working days to credit it back.',
  },
};

/** Per-status hero copy for delivery-update emails. */
const STATUS_EVENT = {
  processing: { emoji: '👩‍🍳', subjectPrefix: 'Being prepared', heading: "We're preparing your order", blurb: 'Our kitchen team has started on your order. Packing is next.' },
  packed: { emoji: '📦', subjectPrefix: 'Packed', heading: 'Your order is packed', blurb: 'Everything is boxed, sealed and ready to hand over to the courier.' },
  shipped: { emoji: '🚚', subjectPrefix: 'Shipped', heading: 'Your order is on its way', blurb: "It's left our Chennai facility and is heading to you. Tracking updates below." },
  out_for_delivery: { emoji: '🛵', subjectPrefix: 'Out for delivery', heading: 'Arriving today', blurb: 'Your order is with the delivery partner and will reach you today. Keep your phone handy.' },
  delivered: { emoji: '🎉', subjectPrefix: 'Delivered', heading: 'Delivered — enjoy!', blurb: 'Your order has been delivered. Your GST invoice is attached as a PDF. We hope you love it.' },
};

/* ── delivery progress tracker (email-safe, table based) ────────────────── */

const TRACKER_STEPS = [
  { key: 'confirmed', label: 'Confirmed', match: ['pending', 'payment_pending', 'processing'] },
  { key: 'packed', label: 'Packed', match: ['packed'] },
  { key: 'shipped', label: 'Shipped', match: ['shipped'] },
  { key: 'out_for_delivery', label: 'Out for delivery', match: ['out_for_delivery'] },
  { key: 'delivered', label: 'Delivered', match: ['delivered'] },
];

function trackerIndex(status) {
  const s = String(status || '').toLowerCase();
  for (let i = TRACKER_STEPS.length - 1; i >= 0; i--) {
    if (TRACKER_STEPS[i].match.includes(s)) return i;
  }
  return 0;
}

function progressTracker(status) {
  const idx = trackerIndex(status);
  const n = TRACKER_STEPS.length;
  // A terminal status (delivered) has no "in progress" step — the current
  // step is itself complete, so it renders filled with a check, not a number.
  const complete = String(status || '').toLowerCase() === 'delivered';
  const dots = TRACKER_STEPS.map((step, i) => {
    const done = i < idx || (complete && i === idx);
    const now = i === idx && !complete;
    const bg = done ? BRAND.berry : now ? '#fff' : BRAND.creamDeep;
    const brd = now ? `2px solid ${BRAND.berry}` : `1px solid ${done ? BRAND.berry : BRAND.line}`;
    const fg = done ? '#fff' : now ? BRAND.berry : BRAND.muted;
    const mark = done ? '&#10003;' : String(i + 1);
    const labelColour = now ? BRAND.berry : done ? BRAND.inkSoft : BRAND.muted;
    return `
      <td width="${Math.floor(100 / n)}%" align="center" style="vertical-align:top">
        <div style="width:30px;height:30px;line-height:26px;margin:0 auto;border-radius:50%;background:${bg};border:${brd};color:${fg};font:800 12px/26px 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;text-align:center">${mark}</div>
        <div style="margin-top:7px;font:700 9.5px/1.3 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:${labelColour}">${step.label}</div>
      </td>`;
  }).join('');

  // progress bar behind the dots — nested block divs (renders in every client)
  const pct = n > 1 ? Math.round((idx / (n - 1)) * 100) : 0;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px">
      <tr><td colspan="${n}" style="padding:0 15px 14px">
        <div style="height:5px;background:${BRAND.creamDeep};border-radius:3px;overflow:hidden">
          <div style="height:5px;width:${Math.max(pct, 3)}%;background:${BRAND.berry};border-radius:3px">&#8203;</div>
        </div>
      </td></tr>
      <tr>${dots}</tr>
    </table>`;
}

const STATUS_LABEL = {
  pending: 'Order confirmed',
  processing: 'Being prepared',
  packed: 'Packed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
};

/* ── layout pieces ─────────────────────────────────────────────────────── */

function itemRows(items, imgCidByIndex) {
  return (items || []).map((it, i) => {
    const cid = imgCidByIndex[i];
    const cell = cid
      ? `<img src="cid:${cid}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:12px;object-fit:cover;border:1px solid ${BRAND.line};background:${BRAND.cream}">`
      : (typeof it.image === 'string' && /^https?:\/\//.test(it.image)
        ? `<img src="${esc(it.image)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:12px;object-fit:cover;border:1px solid ${BRAND.line};background:${BRAND.cream}">`
        : `<div style="width:56px;height:56px;border-radius:12px;border:1px solid ${BRAND.line};background:linear-gradient(160deg,#FBEDF4,#F9F1E1);"></div>`);
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid ${BRAND.line};width:56px;vertical-align:top">${cell}</td>
        <td style="padding:12px 0 12px 14px;border-bottom:1px solid ${BRAND.line};vertical-align:top">
          <div style="font:600 15px/1.3 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink}">${esc(it.name || 'Product')}</div>
          <div style="font:500 12px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted};margin-top:3px">
            ${esc(it.selectedWeight || 'Standard')} &nbsp;·&nbsp; Qty ${Number(it.quantity) || 1}
          </div>
        </td>
        <td style="padding:12px 0;border-bottom:1px solid ${BRAND.line};text-align:right;white-space:nowrap;vertical-align:top;font:700 15px/1.3 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink}">
          ${money((Number(it.price) || 0) * (Number(it.quantity) || 1))}
        </td>
      </tr>`;
  }).join('');
}

function totalsBlock(o) {
  const rows = [];
  const sub = o.subtotal != null ? o.subtotal : (o.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
  rows.push(['Subtotal', money(sub)]);
  if (o.discountAmount > 0) rows.push([`Discount${o.couponCode ? ` · ${esc(o.couponCode)}` : ''}`, `− ${money(o.discountAmount)}`, BRAND.leaf]);
  const fee = o.deliveryFee != null ? o.deliveryFee : o.shipping;
  if (fee != null) {
    const label = o.deliveryMethod === 'fastest' ? 'Delivery · fastest' : 'Delivery';
    rows.push([label, fee === 0 ? 'Free' : money(fee)]);
  }
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">
      ${rows.map(([k, v, colour]) => `
        <tr>
          <td style="padding:7px 0;font:500 13.5px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.inkSoft}">${k}</td>
          <td style="padding:7px 0;text-align:right;font:700 13.5px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${colour || BRAND.ink}">${v}</td>
        </tr>`).join('')}
      <tr><td colspan="2" style="padding:6px 0"><div style="border-top:1px solid ${BRAND.line}"></div></td></tr>
      <tr>
        <td style="padding:4px 0;font:800 12px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.inkSoft}">Total</td>
        <td style="padding:4px 0;text-align:right;font:800 22px/1.2 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.berry}">${money(o.totalAmount)}</td>
      </tr>
    </table>`;
}

function addressBlock(ci = {}) {
  const name = ci.name || `${ci.firstName || ''} ${ci.lastName || ''}`.trim();
  return `
    <div style="font:800 11px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.inkSoft};margin-bottom:8px">Delivering to</div>
    <div style="font:700 14px/1.5 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink}">${esc(name || 'You')}</div>
    <div style="font:500 13px/1.6 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.inkSoft};margin-top:4px">
      ${esc(ci.address || '')}<br>${esc([ci.city, ci.state, ci.pincode].filter(Boolean).join(', '))}
      ${ci.phone ? `<br>${esc(ci.phone)}` : ''}
    </div>`;
}

/* ── the builder ───────────────────────────────────────────────────────── */

/**
 * @param {object}  opts
 * @param {object}  opts.order       the Firestore order doc data
 * @param {string}  opts.orderId     the order document id
 * @param {'placed'|'paid'|'status'|'delivered'|'cancelled'|'refunded'} opts.kind
 * @param {string}  [opts.status]    new status (when kind === 'status')
 * @param {number}  [opts.refundAmount]
 * @returns {{ subject:string, text:string, html:string, attachments:Array }}
 */
function buildOrderEmail({ order, orderId, kind, status, refundAmount }) {
  const isDelivery = kind === 'status';
  const ev = isDelivery
    ? (STATUS_EVENT[String(status || '').toLowerCase()] || EVENTS.status)
    : (EVENTS[kind] || EVENTS.status);
  const sid = shortId(orderId);
  const ci = order.customerInfo || {};
  const items = order.items || [];

  // inline images
  const attachments = [];
  const imgCidByIndex = items.map((it) => {
    const att = imageAttachment(it.image);
    if (att) { attachments.push(att); return att.cid; }
    return null;
  });

  const statusLine = '';

  const payLabel = ci.paymentMethod === 'razorpay' ? 'Paid online' : 'Cash on delivery';
  const trackUrl = `${SITE_URL}/orders`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:${BRAND.cream};-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(ev.heading)} — order ${sid}, ${money(order.totalAmount)}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND.paper};border-radius:20px;overflow:hidden;box-shadow:0 22px 54px -24px rgba(120,10,64,.22)">

        <!-- header -->
        <tr><td style="background:linear-gradient(135deg,${BRAND.berryDeep},${BRAND.berry} 55%,#5F0634);padding:26px 34px">
          <table role="presentation" width="100%"><tr>
            <td style="font:800 20px/1 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.14em;color:#fff;text-transform:uppercase">Alimenture</td>
            <td style="text-align:right;font:700 11px/1 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.1em;color:#F2C24C;text-transform:uppercase">Heritage grains</td>
          </tr></table>
          <div style="height:3px;margin-top:16px;border-radius:2px;background:linear-gradient(90deg,transparent,#F2C24C 30%,#fff 50%,#F2C24C 70%,transparent)"></div>
        </td></tr>

        <!-- hero -->
        <tr><td style="padding:34px 34px 8px;text-align:center">
          <div style="font-size:40px;line-height:1">${ev.emoji}</div>
          <h1 style="margin:14px 0 0;font:800 26px/1.2 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.ink}">${esc(ev.heading)}</h1>
          <p style="margin:10px auto 0;max-width:400px;font:500 14px/1.6 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.inkSoft}">${esc(ev.blurb)}</p>
          <div style="margin-top:16px;display:inline-block">
            <span style="display:inline-block;background:${BRAND.cream};border:1px solid ${BRAND.line};border-radius:999px;padding:7px 15px;font:800 12px/1 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.06em;color:${BRAND.berryDeep}">Order ${sid}</span>
            <span style="display:inline-block;margin-left:8px;font:600 12px/1 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted}">${fmtDate(order.createdAt)}</span>
          </div>
          ${statusLine ? `<p style="margin:14px 0 0;font:500 13px/1.5 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.inkSoft}">${statusLine}</p>` : ''}
          ${kind === 'refunded' && refundAmount ? `<p style="margin:14px 0 0;font:700 15px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.leaf}">Refund amount: ${money(refundAmount)}</p>` : ''}
        </td></tr>

        ${isDelivery ? `
        <!-- delivery progress tracker -->
        <tr><td style="padding:18px 30px 4px">
          <div style="background:${BRAND.cream};border:1px solid ${BRAND.line};border-radius:16px;padding:22px 8px 16px">
            ${progressTracker(status)}
          </div>
        </td></tr>` : ''}

        <!-- CTA -->
        <tr><td style="padding:20px 34px 6px;text-align:center">
          <a href="${esc(trackUrl)}" style="display:inline-block;background:linear-gradient(120deg,${BRAND.berry},#C21A75);color:#fff;text-decoration:none;font:800 12px/1 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;padding:15px 30px;border-radius:999px">${status === 'delivered' ? 'View order &amp; invoice →' : 'Track your order →'}</a>
        </td></tr>

        <!-- items -->
        <tr><td style="padding:24px 34px 6px">
          <div style="font:800 11px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.inkSoft};margin-bottom:4px">${isDelivery ? "What's in this delivery" : 'Items in this order'}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRows(items, imgCidByIndex)}</table>
        </td></tr>

        <!-- totals -->
        <tr><td style="padding:14px 34px 6px">${totalsBlock(order)}
          <div style="margin-top:10px;font:600 12px/1.4 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted}">Payment · ${esc(payLabel)}</div>
        </td></tr>

        <!-- address -->
        <tr><td style="padding:18px 34px 30px">
          <div style="background:${BRAND.cream};border:1px solid ${BRAND.line};border-radius:14px;padding:18px 20px">${addressBlock(ci)}</div>
        </td></tr>

        <!-- footer -->
        <tr><td style="background:linear-gradient(135deg,${BRAND.berryDeep},${BRAND.berry});padding:26px 34px;text-align:center">
          <div style="font:800 14px/1 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.14em;color:#fff;text-transform:uppercase">Alimenture</div>
          <p style="margin:10px 0 0;font:500 11.5px/1.7 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:rgba(255,255,255,.72)">
            Clean-label heritage grains · FSSAI registered · Chennai, Tamil Nadu<br>
            Questions? Reply to this email or visit <a href="${esc(SITE_URL)}" style="color:#F2C24C;text-decoration:none">${esc(SITE_URL.replace(/^https?:\/\//, ''))}</a>
          </p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font:500 11px/1.5 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.muted}">You are receiving this because you placed an order at Alimenture.</p>
    </td></tr>
  </table>
</body></html>`;

  const textLines = [
    `${ev.heading} — Order ${sid}`,
    fmtDate(order.createdAt),
    kind === 'status' ? `Status: ${STATUS_LABEL[status] || status}` : '',
    kind === 'refunded' && refundAmount ? `Refund amount: ${money(refundAmount)}` : '',
    '',
    ...items.map((it) => `  • ${it.name} (${it.selectedWeight || 'Standard'}) x${it.quantity} — ${money((it.price || 0) * (it.quantity || 1))}`),
    '',
    `Total: ${money(order.totalAmount)} · ${payLabel}`,
    '',
    `Track your order: ${trackUrl}`,
  ].filter((l) => l !== '');

  return {
    subject: `${ev.subjectPrefix} · Alimenture ${sid}`,
    text: textLines.join('\n'),
    html,
    attachments,
  };
}

module.exports = { buildOrderEmail, BRAND, money, shortId, fmtDate, SITE_URL };
