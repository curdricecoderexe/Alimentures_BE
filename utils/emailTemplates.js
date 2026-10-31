/**
 * emailTemplates.js — every email the site sends, built on one branded,
 * responsive (table-based) layout, `emailShell`, so order updates, sign-in
 * codes and the newsletter welcome all look like the storefront.
 *
 *   buildOrderEmail    order lifecycle (placed, paid, status, delivered, …)
 *   buildOtpEmail      login / registration / password-reset codes
 *   buildWelcomeEmail  newsletter (Nourishment Circle) welcome
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

// Site fonts first (Apple Mail / iOS load them), then safe fallbacks.
const DISPLAY = "'Outfit','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const BODY = "'Plus Jakarta Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

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
        <div style="width:30px;height:30px;line-height:26px;margin:0 auto;border-radius:50%;background:${bg};border:${brd};color:${fg};font:800 12px/26px ${BODY};text-align:center">${mark}</div>
        <div style="margin-top:7px;font:700 9.5px/1.3 ${BODY};letter-spacing:.04em;text-transform:uppercase;color:${labelColour}">${step.label}</div>
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
          <div style="font:600 15px/1.3 ${BODY};color:${BRAND.ink}">${esc(it.name || 'Product')}</div>
          <div style="font:500 12px/1.4 ${BODY};color:${BRAND.muted};margin-top:3px">
            ${esc(it.selectedWeight || 'Standard')} &nbsp;·&nbsp; Qty ${Number(it.quantity) || 1}
          </div>
        </td>
        <td style="padding:12px 0;border-bottom:1px solid ${BRAND.line};text-align:right;white-space:nowrap;vertical-align:top;font:700 15px/1.3 ${BODY};color:${BRAND.ink}">
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
          <td style="padding:7px 0;font:500 13.5px/1.4 ${BODY};color:${BRAND.inkSoft}">${k}</td>
          <td style="padding:7px 0;text-align:right;font:700 13.5px/1.4 ${BODY};color:${colour || BRAND.ink}">${v}</td>
        </tr>`).join('')}
      <tr><td colspan="2" style="padding:6px 0"><div style="border-top:1px solid ${BRAND.line}"></div></td></tr>
      <tr>
        <td style="padding:4px 0;font:800 12px/1.4 ${BODY};letter-spacing:.08em;text-transform:uppercase;color:${BRAND.inkSoft}">Total</td>
        <td style="padding:4px 0;text-align:right;font:800 22px/1.2 ${BODY};color:${BRAND.berry}">${money(o.totalAmount)}</td>
      </tr>
    </table>`;
}

function addressBlock(ci = {}) {
  const name = ci.name || `${ci.firstName || ''} ${ci.lastName || ''}`.trim();
  return `
    <div style="font:800 11px/1.4 ${BODY};letter-spacing:.14em;text-transform:uppercase;color:${BRAND.inkSoft};margin-bottom:8px">Delivering to</div>
    <div style="font:700 14px/1.5 ${BODY};color:${BRAND.ink}">${esc(name || 'You')}</div>
    <div style="font:500 13px/1.6 ${BODY};color:${BRAND.inkSoft};margin-top:4px">
      ${esc(ci.address || '')}<br>${esc([ci.city, ci.state, ci.pincode].filter(Boolean).join(', '))}
      ${ci.phone ? `<br>${esc(ci.phone)}` : ''}
    </div>`;
}

/* ── shared layout ─────────────────────────────────────────────────────── */

const sectionLabel = (text) =>
  `<div style="font:800 11px/1.4 ${BODY};letter-spacing:.16em;text-transform:uppercase;color:${BRAND.gold};margin-bottom:6px">${esc(text)}</div>`;

/** Gradient pill button (bulletproof enough for Gmail/Outlook.com/Apple Mail). */
const button = ({ href, label }) => `
  <table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr>
    <td style="border-radius:999px;background:${BRAND.berry};background-image:linear-gradient(120deg,${BRAND.berry},#C21A75);box-shadow:0 12px 26px -12px rgba(165,13,90,.7)">
      <a href="${esc(href)}" style="display:inline-block;padding:15px 32px;font:800 12px/1 ${BODY};letter-spacing:.12em;text-transform:uppercase;color:#fff;text-decoration:none;border-radius:999px">${label} &rarr;</a>
    </td>
  </tr></table>`;

const PROMISES = ['0% Maida', '0% White sugar', '0% Refined oil'];

/**
 * The one email layout: berry header with logo, hero (icon, eyebrow, heading,
 * blurb), optional CTA, caller's content rows, promise strip and footer.
 * `content` is a string of <tr> rows for the 600px card.
 */
function emailShell({ preheader = '', icon = '', eyebrow = '', heading, blurb = '', heroExtra = '', cta, content = '', note = '', unsubscribeUrl }) {
  const host = SITE_URL.replace(/^https?:\/\//, '');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${esc(heading)}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700;800&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">
<style>
  @media (max-width:620px){
    .px{padding-left:22px!important;padding-right:22px!important}
    .h1{font-size:24px!important}
    .stack{display:block!important;width:100%!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.cream};-webkit-font-smoothing:antialiased">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};background-image:radial-gradient(60% 40% at 0% 0%,rgba(165,13,90,.08),transparent 70%),radial-gradient(50% 40% at 100% 100%,rgba(215,169,78,.14),transparent 70%);padding:30px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${BRAND.paper};border-radius:24px;overflow:hidden;border:1px solid ${BRAND.line};box-shadow:0 30px 70px -30px rgba(120,10,64,.28)">

        <!-- header -->
        <tr><td class="px" style="background:${BRAND.berryDeep};background-image:linear-gradient(135deg,${BRAND.berryDeep},${BRAND.berry} 55%,#5F0634);padding:22px 34px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle">
              <a href="${esc(SITE_URL)}" style="text-decoration:none">
                <span style="display:inline-block;background:#fff;border-radius:14px;padding:6px 10px;vertical-align:middle">
                  <img src="${esc(SITE_URL)}/logo.png" width="92" alt="Alimenture" style="display:block;width:92px;height:auto;border:0">
                </span>
              </a>
            </td>
            <td style="text-align:right;vertical-align:middle;font:700 10.5px/1.5 ${BODY};letter-spacing:.16em;color:#F2C24C;text-transform:uppercase">Heritage grains<br><span style="color:rgba(255,255,255,.7)">Baked in Chennai</span></td>
          </tr></table>
          <div style="height:2px;margin-top:18px;border-radius:2px;background:linear-gradient(90deg,transparent,#F2C24C 30%,#fff 50%,#F2C24C 70%,transparent)"></div>
        </td></tr>

        <!-- hero -->
        <tr><td class="px" style="padding:36px 34px 6px;text-align:center">
          ${icon ? `<div style="display:inline-block;width:64px;height:64px;line-height:64px;border-radius:50%;background:#FBEDF4;background-image:linear-gradient(140deg,#FBEDF4,${BRAND.goldTint});font-size:30px;text-align:center">${icon}</div>` : ''}
          ${eyebrow ? `<div style="margin-top:16px;font:800 11px/1.4 ${BODY};letter-spacing:.18em;text-transform:uppercase;color:${BRAND.gold}">${esc(eyebrow)}</div>` : ''}
          <h1 class="h1" style="margin:8px 0 0;font:800 28px/1.18 ${DISPLAY};letter-spacing:-.01em;color:${BRAND.ink}">${esc(heading)}</h1>
          ${blurb ? `<p style="margin:12px auto 0;max-width:430px;font:500 14.5px/1.65 ${BODY};color:${BRAND.inkSoft}">${esc(blurb)}</p>` : ''}
          ${heroExtra}
        </td></tr>

        ${cta ? `<tr><td style="padding:24px 34px 4px">${button(cta)}</td></tr>` : ''}

        ${content}

        <!-- promise strip -->
        <tr><td class="px" style="padding:26px 34px 30px;text-align:center">
          ${PROMISES.map((p) => `<span style="display:inline-block;margin:3px;padding:7px 13px;border-radius:999px;background:${BRAND.cream};border:1px solid ${BRAND.line};font:700 11px/1 ${BODY};color:${BRAND.berryDeep}">${p}</span>`).join('')}
        </td></tr>

        <!-- footer -->
        <tr><td class="px" style="background:${BRAND.berryDeep};background-image:linear-gradient(135deg,${BRAND.berryDeep},${BRAND.berry});padding:28px 34px;text-align:center">
          <div style="font:800 15px/1 ${DISPLAY};letter-spacing:.16em;color:#fff;text-transform:uppercase">Alimenture</div>
          <div style="margin-top:14px">
            <a href="${esc(SITE_URL)}/shop" style="color:#F2C24C;text-decoration:none;font:700 12px/1 ${BODY};margin:0 9px">Shop</a>
            <a href="${esc(SITE_URL)}/orders" style="color:#F2C24C;text-decoration:none;font:700 12px/1 ${BODY};margin:0 9px">Track order</a>
            <a href="${esc(SITE_URL)}/policies" style="color:#F2C24C;text-decoration:none;font:700 12px/1 ${BODY};margin:0 9px">Policies</a>
          </div>
          <p style="margin:14px 0 0;font:500 11.5px/1.7 ${BODY};color:rgba(255,255,255,.75)">
            Alimenture Industries Pvt Ltd · FSSAI registered · Chennai, Tamil Nadu<br>
            Questions? Reply to this email or visit <a href="${esc(SITE_URL)}" style="color:#fff;text-decoration:underline">${esc(host)}</a>
          </p>
        </td></tr>
      </table>
      ${note || unsubscribeUrl ? `<p style="margin:16px 0 0;max-width:520px;font:500 11px/1.6 ${BODY};color:${BRAND.muted}">
        ${esc(note)}${unsubscribeUrl ? ` <a href="${esc(unsubscribeUrl)}" style="color:${BRAND.muted};text-decoration:underline">Unsubscribe</a>` : ''}
      </p>` : ''}
    </td></tr>
  </table>
</body></html>`;
}

/* ── order emails ──────────────────────────────────────────────────────── */

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

  // Courier + AWB once a Shiprocket shipment is in motion.
  const sh = order.shipment || {};
  const inTransit = isDelivery && ['shipped', 'out_for_delivery'].includes(String(status || '').toLowerCase());
  const statusLine = inTransit && sh.awb
    ? `Courier: <strong>${esc(sh.courierName || 'Our courier partner')}</strong> · AWB <strong>${esc(sh.awb)}</strong>`
    : '';

  const payLabel = ci.paymentMethod === 'razorpay' ? 'Paid online' : 'Cash on delivery';
  const trackUrl = `${SITE_URL}/orders`;

  const content = `
        ${isDelivery ? `
        <!-- delivery progress tracker -->
        <tr><td style="padding:22px 30px 4px">
          <div style="background:${BRAND.cream};border:1px solid ${BRAND.line};border-radius:18px;padding:22px 8px 16px">
            ${progressTracker(status)}
          </div>
        </td></tr>` : ''}

        <!-- items -->
        <tr><td style="padding:24px 34px 6px">
          ${sectionLabel(isDelivery ? "What's in this delivery" : 'Items in this order')}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRows(items, imgCidByIndex)}</table>
        </td></tr>

        <!-- totals -->
        <tr><td style="padding:14px 34px 6px">${totalsBlock(order)}
          <div style="margin-top:10px;font:600 12px/1.4 ${BODY};color:${BRAND.muted}">Payment · ${esc(payLabel)}</div>
        </td></tr>

        <!-- address -->
        <tr><td style="padding:18px 34px 8px">
          <div style="background:${BRAND.cream};border:1px solid ${BRAND.line};border-radius:16px;padding:18px 20px">${addressBlock(ci)}</div>
        </td></tr>`;

  const html = emailShell({
    preheader: `${ev.heading} — order ${sid}, ${money(order.totalAmount)}.`,
    icon: ev.emoji,
    eyebrow: `Order ${sid} · ${fmtDate(order.createdAt)}`,
    heading: ev.heading,
    blurb: ev.blurb,
    heroExtra: [
      statusLine ? `<p style="margin:14px 0 0;font:500 13px/1.5 ${BODY};color:${BRAND.inkSoft}">${statusLine}</p>` : '',
      kind === 'refunded' && refundAmount ? `<p style="margin:14px 0 0;font:700 15px/1.4 ${BODY};color:${BRAND.leaf}">Refund amount: ${money(refundAmount)}</p>` : '',
    ].join(''),
    cta: { href: trackUrl, label: status === 'delivered' ? 'View order &amp; invoice' : 'Track your order' },
    content,
    note: 'You are receiving this because you placed an order at Alimenture.',
  });

  const textLines = [
    `${ev.heading} — Order ${sid}`,
    fmtDate(order.createdAt),
    kind === 'status' ? `Status: ${STATUS_LABEL[status] || status}` : '',
    inTransit && sh.awb ? `Courier: ${sh.courierName || 'Our courier partner'} · AWB ${sh.awb}` : '',
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

/* ── sign-in / registration / reset codes ──────────────────────────────── */

const OTP_COPY = {
  login: { icon: '🔐', subject: 'Your Alimenture sign-in code', eyebrow: 'Sign-in verification', heading: "Verify it's you", blurb: 'Use this code to finish signing in to your Alimenture account.' },
  register: { icon: '🌾', subject: 'Your Alimenture verification code', eyebrow: 'Welcome to Alimenture', heading: 'Confirm your email', blurb: 'Use this code to finish creating your Alimenture account.' },
  reset: { icon: '🔑', subject: 'Your Alimenture password reset code', eyebrow: 'Password reset', heading: 'Reset your password', blurb: 'Use this code to choose a new password for your Alimenture account.' },
};

/**
 * @param {object} opts
 * @param {'login'|'register'|'reset'} opts.purpose
 * @param {string} opts.otp
 * @param {number} [opts.minutes=10]  code lifetime
 */
function buildOtpEmail({ purpose, otp, minutes = 10 }) {
  const c = OTP_COPY[purpose] || OTP_COPY.login;
  const digits = String(otp).split('').map((d) =>
    `<td style="padding:0 4px"><div style="width:44px;height:56px;line-height:56px;border-radius:14px;background:#fff;border:1px solid ${BRAND.line};box-shadow:0 6px 14px -8px rgba(120,10,64,.35);font:800 28px/56px ${DISPLAY};color:${BRAND.berryDeep};text-align:center">${esc(d)}</div></td>`).join('');
  const content = `
        <tr><td class="px" style="padding:24px 34px 4px">
          <div style="background:${BRAND.cream};background-image:linear-gradient(140deg,#FBEDF4,${BRAND.goldTint});border-radius:20px;padding:24px 10px;text-align:center">
            ${sectionLabel('Your one-time code')}
            <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin-top:8px"><tr>${digits}</tr></table>
            <div style="margin-top:14px;font:600 12.5px/1.5 ${BODY};color:${BRAND.inkSoft}">Expires in ${minutes} minutes</div>
          </div>
        </td></tr>
        <tr><td class="px" style="padding:18px 34px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.line};border-radius:14px"><tr>
            <td style="padding:14px 16px;font:500 12.5px/1.6 ${BODY};color:${BRAND.inkSoft}">
              <strong style="color:${BRAND.ink}">Keep this code private.</strong> Alimenture will never ask you for it by phone, chat or email.
              If you didn't request it, you can safely ignore this email.
            </td>
          </tr></table>
        </td></tr>`;
  return {
    subject: c.subject,
    text: `${c.heading}\n\nYour code: ${otp}\nIt expires in ${minutes} minutes. Do not share it with anyone.\n\nIf you didn't request this, ignore this email.\n\n${SITE_URL}`,
    html: emailShell({
      preheader: `Your code is ${otp} — it expires in ${minutes} minutes.`,
      icon: c.icon,
      eyebrow: c.eyebrow,
      heading: c.heading,
      blurb: c.blurb,
      content,
      note: 'This is an automated security email from Alimenture.',
    }),
    attachments: [],
  };
}

/* ── newsletter welcome ────────────────────────────────────────────────── */

/**
 * @param {object}   opts
 * @param {object[]} [opts.products]  up to 4 { name, tagline, price, image (data URL or https), url }
 * @param {string}   opts.unsubscribeUrl
 */
function buildWelcomeEmail({ products = [], unsubscribeUrl }) {
  const attachments = [];
  const perks = [
    ['📖', 'Heritage recipes', 'Traditional recipes built around millets and heritage grains.'],
    ['🥗', 'Meal-prep ideas', 'Simple, wholesome ideas for everyday family meals.'],
    ['✨', 'First to know', 'Early word on new products and limited farm-fresh batches.'],
  ];
  const perkRows = perks.map(([emoji, title, desc]) => `
          <tr>
            <td style="width:52px;padding:10px 0;vertical-align:top">
              <div style="width:42px;height:42px;line-height:42px;border-radius:14px;background:#FBEDF4;font-size:20px;text-align:center">${emoji}</div>
            </td>
            <td style="padding:10px 0 10px 12px;vertical-align:top">
              <div style="font:700 15px/1.3 ${DISPLAY};color:${BRAND.ink}">${title}</div>
              <div style="margin-top:3px;font:500 13px/1.55 ${BODY};color:${BRAND.inkSoft}">${desc}</div>
            </td>
          </tr>`).join('');

  const picks = products.slice(0, 4).map((p) => {
    let src = /^https?:\/\//.test(p.image || '') ? p.image : null;
    if (!src) {
      const att = imageAttachment(p.image);
      if (att) { attachments.push(att); src = `cid:${att.cid}`; }
    }
    return `
              <td class="stack" width="50%" style="padding:6px;vertical-align:top">
                <a href="${esc(p.url)}" style="display:block;text-decoration:none;background:#fff;border:1px solid ${BRAND.line};border-radius:18px;overflow:hidden">
                  ${src ? `<img src="${esc(src)}" width="250" alt="${esc(p.name)}" style="display:block;width:100%;height:auto;border:0;background:${BRAND.cream}">` : ''}
                  <div style="padding:12px 14px 14px">
                    <div style="font:700 14px/1.3 ${DISPLAY};color:${BRAND.ink}">${esc(p.name)}</div>
                    ${p.tagline ? `<div style="margin-top:3px;font:500 11.5px/1.45 ${BODY};color:${BRAND.muted}">${esc(p.tagline)}</div>` : ''}
                    ${p.price ? `<div style="margin-top:8px;font:800 15px/1 ${DISPLAY};color:${BRAND.berry}">${p.from ? '<span style="font:600 11px ' + BODY + ';color:' + BRAND.muted + '">from </span>' : ''}${money(p.price)}</div>` : ''}
                  </div>
                </a>
              </td>`;
  });
  const pickRows = [];
  for (let i = 0; i < picks.length; i += 2) pickRows.push(`<tr>${picks[i]}${picks[i + 1] || '<td class="stack" width="50%"></td>'}</tr>`);

  const content = `
        <tr><td class="px" style="padding:26px 34px 4px">
          ${sectionLabel("What you'll receive")}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${perkRows}</table>
        </td></tr>
        ${pickRows.length ? `
        <tr><td class="px" style="padding:22px 28px 4px">
          <div style="padding:0 6px">${sectionLabel('Start with our favourites')}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${pickRows.join('')}</table>
        </td></tr>` : ''}`;

  return {
    subject: 'Welcome to the Alimenture Nourishment Circle 🌾',
    text: [
      'Welcome to the Alimenture Nourishment Circle!',
      '',
      "You'll receive heritage recipes, meal-prep ideas and early word on new products and limited batches.",
      '',
      ...products.slice(0, 4).map((p) => `• ${p.name}${p.price ? ` — ${money(p.price)}` : ''}: ${p.url}`),
      '',
      `Shop: ${SITE_URL}/shop`,
      `Unsubscribe: ${unsubscribeUrl}`,
    ].join('\n'),
    html: emailShell({
      preheader: 'Heritage recipes, meal-prep ideas and first word on new batches — welcome aboard.',
      icon: '🌾',
      eyebrow: 'Welcome to the circle',
      heading: "You're in — welcome to the Nourishment Circle",
      blurb: "Thanks for joining Alimenture's clean food community. Here's what to expect from us.",
      cta: { href: `${SITE_URL}/shop`, label: 'Explore the shop' },
      content,
      note: "You're receiving this because you subscribed on alimenture.in.",
      unsubscribeUrl,
    }),
    attachments,
  };
}

module.exports = { buildOrderEmail, buildOtpEmail, buildWelcomeEmail, emailShell, BRAND, money, shortId, fmtDate, SITE_URL };
