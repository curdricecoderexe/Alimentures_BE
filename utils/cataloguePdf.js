/**
 * cataloguePdf.js — builds a branded product catalogue PDF (Buffer) from the
 * live product list, using pdfkit. Served by the lead-gated catalogue download
 * whenever the admin hasn't uploaded a PDF of their own.
 *
 * Only real catalogue data is printed: names, admin-entered descriptions and
 * key ingredients, pack sizes and current prices (dated, since they change).
 * pdfkit's built-in Helvetica has no ₹ glyph, so prices are printed as "Rs.".
 */
'use strict';

const PDFDocument = require('pdfkit');
const { buildSlugMap } = require('../lib/slug');

const C = {
  berry: '#A50D5A',
  berryDeep: '#79083F',
  gold: '#B27B26',
  goldLt: '#F2C24C',
  ink: '#221B1F',
  inkSoft: '#5A4F55',
  muted: '#8E848B',
  line: '#E7DECB',
  cream: '#FBF7EF',
  white: '#FFFFFF',
};

const SITE = (process.env.DOMAIN || 'https://alimenture.in').replace(/\/+$/, '');
const CONTACT = {
  phones: ['+91 98847 33453', '+91 73581 96132'],
  email: 'alimentureindustries@gmail.com',
};

const rs = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN')}`;

/** "TRI-GRAIN GAIN — PREMIUM" -> "Tri-Grain Gain - Premium" (Helvetica lacks the em dash). */
const displayName = (text) => {
  const s = String(text || '').trim().replace(/[—–]/g, '-');
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s(\-/&])([a-z])/g, (m, sep, c) => sep + c.toUpperCase())
    .replace(/\b([a-z]\d+|\d+[a-z]+)\b/gi, (w) => w.toUpperCase());
};
const sentence = (text) => {
  const s = displayName(text).replace(/\s+/g, ' ').trim();
  const lower = s === s.toUpperCase() ? s.toLowerCase() : s;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};
// Helvetica (WinAnsi) can't draw these; swap for close equivalents.
const safe = (s) => String(s || '').replace(/[—–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/₹/g, 'Rs. ');

function keyIngredients(p) {
  const m = String(p.secondaryDescription || '').match(/Key Ingredients?\s*:\s*([^\n]+?)(?:\.(?:\s|$)|\n|\s+0%|$)/i);
  return m ? m[1].trim() : '';
}

function offers(p) {
  const vs = (p.variants || []).filter((v) => Number(v.price) > 0);
  if (!vs.length) return Number(p.price) > 0 ? [{ weight: p.weight || '', price: Number(p.price) }] : [];
  return vs.map((v) => ({ weight: String(v.weight || '').trim(), price: Number(v.price) }));
}

/** Decode an inline base64 photo pdfkit can draw (JPEG/PNG), else null. */
function imageBuffer(src) {
  const m = /^data:image\/(jpe?g|png);base64,/i.exec(String(src || ''));
  if (!m) return null;
  try { return Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'); } catch { return null; }
}

/**
 * @param {object[]} products  public products ({ id, title, category, ... })
 * @returns {Promise<Buffer>}
 */
function buildCataloguePdf(products) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Alimenture Product Catalogue', Author: 'Alimenture Industries' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;
    const M = 40;
    const CW = W - M * 2;
    const slugs = buildSlugMap(products);
    const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

    // Group by category, keeping the catalogue's own order within each.
    const groups = new Map();
    for (const p of products) {
      const cat = (p.category || 'Products').trim();
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(p);
    }

    /* ── cover ── */
    doc.rect(0, 0, W, H).fill(C.berry);
    doc.rect(0, H * 0.62, W, H * 0.38).fill(C.berryDeep);
    doc.fillColor(C.goldLt).font('Helvetica-Bold').fontSize(10).text('PRODUCT CATALOGUE', M, 150, { characterSpacing: 4 });
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(46).text('ALIMENTURE', M, 172, { characterSpacing: 4 });
    doc.font('Helvetica').fontSize(14).fillColor('#FBE3EF')
      .text('Millet & heritage-rice cookies, ghee, honey and wholesome bakes', M, 236, { width: CW });
    doc.font('Helvetica').fontSize(11).fillColor('#FBE3EF')
      .text('Made in Chennai, Tamil Nadu  ·  Delivered across India', M, 266);

    let cy = H * 0.62 + 40;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.goldLt).text('INSIDE', M, cy, { characterSpacing: 2 });
    cy += 18;
    for (const [cat, items] of groups) {
      doc.font('Helvetica').fontSize(12).fillColor(C.white).text(`${safe(cat)}  ·  ${items.length} product${items.length === 1 ? '' : 's'}`, M, cy);
      cy += 20;
    }
    doc.font('Helvetica').fontSize(9).fillColor('#E9B9D2')
      .text(`Prices as of ${today}. Current prices and availability: ${SITE.replace(/^https?:\/\//, '')}`, M, H - 60, { width: CW });

    /* ── product pages: 2 × 3 grid of cards ── */
    const COLS = 2;
    const GAP = 16;
    const CARD_W = (CW - GAP) / COLS;
    const CARD_H = 228;
    const IMG_H = 108;
    const TOP = 78;

    const header = (cat, cont) => {
      doc.rect(0, 0, W, 56).fill(C.berry);
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(13).text('ALIMENTURE', M, 21, { characterSpacing: 2.5 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(C.goldLt)
        .text(`${safe(cat).toUpperCase()}${cont ? ' (CONTINUED)' : ''}`, M, 23, { width: CW, align: 'right', characterSpacing: 1.5 });
    };
    const footer = () => {
      doc.font('Helvetica').fontSize(8).fillColor(C.muted)
        .text(`Order online at ${SITE.replace(/^https?:\/\//, '')}  ·  ${CONTACT.phones.join('  ·  ')}  ·  ${CONTACT.email}`, M, H - 30, { width: CW, align: 'center', lineBreak: false });
    };

    for (const [cat, items] of groups) {
      items.forEach((p, i) => {
        const slot = i % 6;
        if (slot === 0) {
          doc.addPage({ size: 'A4', margin: 0 });
          doc.rect(0, 0, W, H).fill(C.cream);
          header(cat, i > 0);
          footer();
        }
        const x = M + (slot % COLS) * (CARD_W + GAP);
        const y = TOP + Math.floor(slot / COLS) * (CARD_H + GAP);

        doc.roundedRect(x, y, CARD_W, CARD_H, 10).fill(C.white);
        doc.roundedRect(x, y, CARD_W, CARD_H, 10).lineWidth(0.6).strokeColor(C.line).stroke();

        const img = imageBuffer(p.image);
        if (img) {
          try {
            doc.save();
            doc.roundedRect(x + 8, y + 8, CARD_W - 16, IMG_H, 7).clip();
            doc.image(img, x + 8, y + 8, { cover: [CARD_W - 16, IMG_H], align: 'center', valign: 'center' });
            doc.restore();
          } catch {
            doc.restore();
            doc.roundedRect(x + 8, y + 8, CARD_W - 16, IMG_H, 7).fill(C.cream);
          }
        } else {
          doc.roundedRect(x + 8, y + 8, CARD_W - 16, IMG_H, 7).fill(C.cream);
        }

        const tx = x + 12;
        const tw = CARD_W - 24;
        let ty = y + IMG_H + 18;
        doc.font('Helvetica-Bold').fontSize(11.5).fillColor(C.ink)
          .text(safe(displayName(p.title || p.name)), tx, ty, { width: tw, height: 15, ellipsis: true, lineBreak: false });
        ty += 16;
        if (p.description) {
          doc.font('Helvetica').fontSize(8.5).fillColor(C.berry)
            .text(safe(sentence(p.description)), tx, ty, { width: tw, height: 11, ellipsis: true, lineBreak: false });
          ty += 13;
        }
        const ing = keyIngredients(p);
        if (ing) {
          doc.font('Helvetica').fontSize(7.8).fillColor(C.inkSoft)
            .text(safe(`Key ingredients: ${ing}`), tx, ty, { width: tw, height: 30, ellipsis: true });
        }

        // price row
        const priceY = y + CARD_H - 34;
        doc.moveTo(tx, priceY - 6).lineTo(tx + tw, priceY - 6).lineWidth(0.5).strokeColor(C.line).stroke();
        const list = offers(p);
        const priceText = list.map((o) => `${o.weight ? `${safe(o.weight)} · ` : ''}${rs(o.price)}`).join('   |   ');
        doc.font('Helvetica-Bold').fontSize(10).fillColor(C.berryDeep)
          .text(priceText || 'See website for price', tx, priceY, { width: tw, height: 13, ellipsis: true, lineBreak: false });
        const url = `${SITE}/products/${slugs.get(p.id) || p.id}`;
        doc.font('Helvetica').fontSize(7.5).fillColor(C.gold)
          .text(url.replace(/^https?:\/\//, ''), tx, priceY + 14, { width: tw, height: 10, ellipsis: true, lineBreak: false, link: url, underline: false });
      });
    }

    /* ── back page: how to order ── */
    doc.addPage({ size: 'A4', margin: 0 });
    doc.rect(0, 0, W, H).fill(C.berryDeep);
    doc.fillColor(C.goldLt).font('Helvetica-Bold').fontSize(10).text('HOW TO ORDER', M, 160, { characterSpacing: 3 });
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(28).text(`Shop online at ${SITE.replace(/^https?:\/\//, '')}`, M, 182, { width: CW, link: SITE });
    doc.font('Helvetica').fontSize(12).fillColor('#FBE3EF')
      .text('Browse the full range, check delivery to your PIN code and pay securely online.', M, 230, { width: CW });
    let by = 290;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.goldLt).text('CONTACT US', M, by, { characterSpacing: 2 });
    by += 18;
    for (const line of [...CONTACT.phones, CONTACT.email, 'Chennai, Tamil Nadu, India']) {
      doc.font('Helvetica').fontSize(12).fillColor(C.white).text(line, M, by);
      by += 20;
    }
    doc.font('Helvetica').fontSize(8.5).fillColor('#E9B9D2')
      .text(`Alimenture Industries Private Limited. Prices as of ${today} and subject to change; the website always shows current prices and stock.`, M, H - 60, { width: CW });

    doc.end();
  });
}

module.exports = { buildCataloguePdf };
