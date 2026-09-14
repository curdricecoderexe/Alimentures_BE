/**
 * invoicePdf.js — generates a modern, branded GST invoice PDF (Buffer) for a
 * delivered order, using pdfkit (pure JS, no headless browser).
 *
 * pdfkit's built-in Helvetica has no ₹ glyph, so amounts are printed as "Rs.".
 */
'use strict';

const PDFDocument = require('pdfkit');

const C = {
  berry: '#A50D5A',
  berryDeep: '#79083F',
  gold: '#B27B26',
  goldLt: '#D7A94E',
  ink: '#221B1F',
  inkSoft: '#5A4F55',
  muted: '#8E848B',
  line: '#E7DECB',
  cream: '#FBF7EF',
  leaf: '#2E7D51',
  white: '#FFFFFF',
};

const rs = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN')}`;
const shortId = (id) => `#${String(id || '').slice(-8).toUpperCase()}`;
const fmtDate = (ts) => {
  const d = ts?.toDate ? ts.toDate() : ts?._seconds ? new Date(ts._seconds * 1000) : ts ? new Date(ts) : new Date();
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/**
 * @param {object} order    Firestore order doc data
 * @param {string} orderId
 * @returns {Promise<Buffer>}
 */
function buildInvoicePdf(order, orderId) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_W = doc.page.width;      // 595.28
    const M = 48;                        // content margin
    const CW = PAGE_W - M * 2;           // content width
    const ci = order.customerInfo || {};
    const items = order.items || [];
    const sub = order.subtotal != null
      ? order.subtotal
      : items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);
    const paid = order.customerInfo?.paymentMethod === 'razorpay';

    /* ── header band ── */
    doc.rect(0, 0, PAGE_W, 92).fill(C.berryDeep);
    doc.rect(0, 0, PAGE_W, 92).fillOpacity(1).fill(C.berry);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(19)
      .text('ALIMENTURE', M, 30, { characterSpacing: 3 });
    doc.font('Helvetica').fontSize(8).fillColor('#F2C24C')
      .text('HERITAGE GRAINS  ·  CHENNAI', M, 54, { characterSpacing: 1.5 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(C.white)
      .text('TAX INVOICE', M, 34, { width: CW, align: 'right' });
    doc.font('Helvetica').fontSize(8.5).fillColor('#F2C24C')
      .text(`Invoice ${shortId(orderId)}`, M, 56, { width: CW, align: 'right' });
    // gold foil rule
    doc.rect(0, 92, PAGE_W, 3).fill(C.goldLt);

    let y = 120;

    /* ── meta row ── */
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted).text('INVOICE DATE', M, y, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted).text('ORDER REFERENCE', M + 170, y, { characterSpacing: 1 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted).text('STATUS', M + 340, y, { characterSpacing: 1 });
    doc.font('Helvetica').fontSize(11).fillColor(C.ink).text(fmtDate(order.paidAt || order.createdAt), M, y + 13);
    doc.text(shortId(orderId), M + 170, y + 13);
    doc.font('Helvetica-Bold').fillColor(C.leaf).text('DELIVERED · PAID', M + 340, y + 13);

    y += 44;
    doc.moveTo(M, y).lineTo(M + CW, y).strokeColor(C.line).lineWidth(1).stroke();
    y += 22;

    /* ── from / bill-to ── */
    const colW = (CW - 24) / 2;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted).text('FROM', M, y, { characterSpacing: 1.5 });
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted).text('BILLED & SHIPPED TO', M + colW + 24, y, { characterSpacing: 1.5 });
    y += 14;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.ink)
      .text('Alimenture Industries Pvt Ltd', M, y, { width: colW });
    doc.font('Helvetica').fontSize(9).fillColor(C.inkSoft)
      .text('Chennai, Tamil Nadu, India\nFSSAI registered food business operator\nsupport@alimenture.com', M, y + 15, { width: colW, lineGap: 2 });

    const name = ci.name || `${ci.firstName || ''} ${ci.lastName || ''}`.trim() || 'Customer';
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(C.ink)
      .text(name, M + colW + 24, y, { width: colW });
    doc.font('Helvetica').fontSize(9).fillColor(C.inkSoft)
      .text(
        [ci.address, [ci.city, ci.state, ci.pincode].filter(Boolean).join(', '), ci.phone, ci.email].filter(Boolean).join('\n'),
        M + colW + 24, y + 15, { width: colW, lineGap: 2 },
      );

    y += 92;

    /* ── items table ── */
    const cols = { idx: M + 10, name: M + 40, qty: M + CW - 200, unit: M + CW - 130, amt: M + CW - 10 };
    doc.rect(M, y, CW, 26).fill(C.berry);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(C.white).characterSpacing = 1;
    doc.text('#', cols.idx, y + 9);
    doc.text('ITEM', cols.name, y + 9);
    doc.text('QTY', cols.qty, y + 9, { width: 40, align: 'right' });
    doc.text('UNIT', cols.unit, y + 9, { width: 60, align: 'right' });
    doc.text('AMOUNT', cols.amt - 90, y + 9, { width: 90, align: 'right' });
    doc.characterSpacing = 0;
    y += 26;

    items.forEach((it, i) => {
      const qty = Number(it.quantity) || 1;
      const unit = Number(it.price) || 0;
      const rowH = 30;
      if (i % 2 === 1) doc.rect(M, y, CW, rowH).fill(C.cream);
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(String(i + 1), cols.idx, y + 8);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink)
        .text(it.name || 'Product', cols.name, y + 5, { width: cols.qty - cols.name - 12 });
      doc.font('Helvetica').fontSize(8).fillColor(C.muted)
        .text(it.selectedWeight || 'Standard', cols.name, y + 17, { width: cols.qty - cols.name - 12 });
      doc.font('Helvetica').fontSize(9.5).fillColor(C.ink)
        .text(String(qty), cols.qty, y + 8, { width: 40, align: 'right' })
        .text(rs(unit), cols.unit, y + 8, { width: 60, align: 'right' })
        .font('Helvetica-Bold')
        .text(rs(unit * qty), cols.amt - 90, y + 8, { width: 90, align: 'right' });
      doc.moveTo(M, y + rowH).lineTo(M + CW, y + rowH).strokeColor(C.line).lineWidth(0.8).stroke();
      y += rowH;
    });

    y += 16;

    /* ── totals ── */
    const totX = M + CW - 230;
    const totW = 230;
    const totRow = (label, value, opts = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.big ? 12 : 9.5)
        .fillColor(opts.colour || C.inkSoft)
        .text(label, totX, y, { width: totW - 110 });
      doc.font('Helvetica-Bold').fontSize(opts.big ? 13.5 : 10)
        .fillColor(opts.colour || (opts.big ? C.berry : C.ink))
        .text(value, totX + totW - 110, y - (opts.big ? 2 : 0), { width: 110, align: 'right' });
      y += opts.big ? 24 : 17;
    };
    totRow('Subtotal', rs(sub));
    if (order.discountAmount > 0) totRow(`Discount${order.couponCode ? ` (${order.couponCode})` : ''}`, `- ${rs(order.discountAmount)}`, { colour: C.leaf });
    const delFee = order.deliveryFee != null ? order.deliveryFee : order.shipping;
    if (delFee != null) {
      totRow(order.deliveryMethod === 'fastest' ? 'Delivery (fastest)' : 'Delivery', delFee === 0 ? 'Free' : rs(delFee));
    }
    doc.moveTo(totX, y + 2).lineTo(totX + totW, y + 2).strokeColor(C.line).lineWidth(1).stroke();
    y += 12;
    totRow('TOTAL PAID', rs(order.totalAmount), { big: true, bold: true });

    y += 6;
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
      .text(`Payment method: ${paid ? 'Online (Razorpay)' : 'Cash on delivery'}   ·   Amount inclusive of all applicable taxes`, M, y, { width: CW });

    /* ── footer ── */
    const fy = doc.page.height - 96;
    doc.rect(0, fy, PAGE_W, 3).fill(C.goldLt);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.berry)
      .text('Thank you for choosing clean.', M, fy + 20, { width: CW, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text('This is a computer-generated invoice and does not require a signature.\nAlimenture Industries Pvt Ltd  ·  Chennai, Tamil Nadu  ·  alimenture.com', M, fy + 40, { width: CW, align: 'center', lineGap: 2 });

    doc.end();
  });
}

module.exports = { buildInvoicePdf };
