/**
 * faqBot.js — the "Chat with us" assistant. A keyword/intent matcher (no AI
 * service, no API cost) that answers ONLY from live site data:
 *
 *   products      live catalogue — names, prices, pack sizes, stock, key ingredients
 *   delivery      Admin → PIN Code Delivery settings + per-PIN serviceability
 *   orders        the signed-in customer's own recent orders
 *   policies      mirrors the published policy pages (src/data/policies.js on the
 *                 storefront) — keep POLICY_ANSWERS in sync when those change
 *
 * Anything it can't answer confidently is handed off to a live specialist.
 */
'use strict';

const db = require('../config/firebase');
const { getCachedProducts } = require('../controllers/productController');
const { buildSlugMap } = require('../lib/slug');
const delivery = require('./deliveryService');

const SITE = (process.env.DOMAIN || 'https://alimenture.in').replace(/\/+$/, '');
const CONTACT = { email: 'alimentureindustries@gmail.com', phones: ['+91 98847 33453', '+91 73581 96132'] };

const DEFAULT_SUGGESTIONS = [
  'What products do you have?',
  'Delivery charges & time',
  'Is it maida free?',
  'Where is my order?',
];

// ─── text helpers ────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9₹\s]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'do', 'does', 'you', 'your', 'i', 'me', 'my', 'of', 'for', 'to', 'in',
  'and', 'or', 'it', 'this', 'that', 'what', 'which', 'how', 'can', 'please', 'about', 'tell', 'have', 'has', 'with', 'any',
  'there', 'on', 'be', 'get', 'want', 'need', 'know', 'details', 'detail', 'price', 'cost', 'buy', 'premium', 'elite']);
const tokens = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t));
const has = (text, words) => words.some((w) => (w.includes(' ') ? text.includes(w) : new RegExp(`\\b${w}`).test(text)));

const titleCase = (s) => {
  const t = String(s || '').trim();
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s(\-–—/&])([a-z])/g, (m, a, c) => a + c.toUpperCase());
};
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

function keyIngredients(p) {
  const m = String(p.secondaryDescription || '').match(/Key Ingredients?\s*:\s*([^\n]+?)(?:\.(?:\s|$)|\n|\s+0%|$)/i);
  return m ? m[1].trim() : '';
}

// ─── catalogue ───────────────────────────────────────────────────────────────

async function catalogue() {
  const all = (await getCachedProducts()).filter((p) => p.isDraft !== true && p.isPrivate !== true);
  const slugs = buildSlugMap(all);
  return all.map((p) => {
    const variants = (p.variants || []).filter((v) => Number(v.price) > 0);
    const prices = variants.length ? variants.map((v) => Number(v.price)) : [Number(p.price) || 0];
    const name = titleCase(p.title || p.name);
    const ingredients = keyIngredients(p);
    return {
      id: p.id,
      name,
      category: (p.category || '').trim(),
      tagline: p.description ? titleCase(p.description) : '',
      ingredients,
      sizes: variants.map((v) => String(v.weight || '').trim()).filter(Boolean),
      price: Math.min(...prices),
      from: prices.length > 1,
      inStock: variants.length ? variants.some((v) => Number(v.stock) > 0) : Number(p.stock) > 0,
      featured: !!p.isFeatured,
      url: `${SITE}/products/${slugs.get(p.id) || p.id}`,
      // what a question can match on
      nameText: norm(`${p.title || ''} ${p.name || ''}`),
      searchText: norm(`${p.title || ''} ${p.category || ''} ${p.description || ''} ${ingredients}`),
    };
  });
}

const card = (p) => ({ id: p.id, name: p.name, price: p.price, from: p.from, sizes: p.sizes, inStock: p.inStock, url: p.url, tagline: p.tagline });

function scoreProducts(products, text) {
  const qTokens = tokens(text);
  return products.map((p) => {
    const nameTokens = tokens(p.nameText);
    const nameHits = nameTokens.filter((t) => qTokens.some((q) => q === t || (q.length > 3 && t.startsWith(q)))).length;
    const otherHits = qTokens.filter((q) => q.length > 2 && p.searchText.includes(q)).length;
    const variantHint = (/\belite\b/.test(text) && /elite/.test(p.nameText)) || (/\bpremium\b/.test(text) && /premium/.test(p.nameText)) ? 1 : 0;
    return { p, nameHits, nameRatio: nameTokens.length ? nameHits / nameTokens.length : 0, score: nameHits * 3 + otherHits + variantHint * 2 };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
}

function productDetail(p) {
  const lines = [`${p.name}${p.tagline ? ` — ${p.tagline}` : ''}`];
  lines.push(`Price: ${p.from ? 'from ' : ''}${money(p.price)}${p.sizes.length ? ` (${p.sizes.join(' / ')})` : ''}`);
  if (p.ingredients) lines.push(`Key ingredients: ${p.ingredients}`);
  lines.push(p.inStock ? 'In stock and ready to order.' : 'Currently sold out — check back soon.');
  return lines.join('\n');
}

// ─── policy answers (mirror the published policy pages) ──────────────────────

const POLICY_ANSWERS = [
  {
    id: 'payment',
    words: ['pay', 'payment', 'cod', 'cash on delivery', 'cash', 'upi', 'card', 'netbanking', 'razorpay', 'gpay', 'wallet'],
    reply: 'We accept online payment only — UPI, debit/credit cards, netbanking and wallets through Razorpay. Cash on delivery is not offered. Card details are handled by the payment provider and never stored on our servers.',
    links: [{ label: 'Terms of Service', url: `${SITE}/policies/terms-of-service` }],
  },
  {
    id: 'cancel',
    words: ['cancel', 'cancellation'],
    reply: "Orders can't be cancelled once they're placed, including before dispatch. If a payment attempt fails or you close the payment window, no order is placed and nothing is charged. If we're ever unable to ship a paid order, we refund it in full.",
    links: [{ label: 'Cancellation Policy', url: `${SITE}/policies/cancellation-policy` }],
  },
  {
    id: 'returns',
    words: ['return', 'refund', 'damaged', 'damage', 'broken', 'expired', 'wrong item', 'incorrect', 'replace', 'replacement', 'defective', 'tampered'],
    reply: 'If a product arrives damaged, expired, incorrect or defective, you can raise a return within 3 days of delivery — please share your order details and photos. We arrange a free reverse pickup (or may refund/replace from photos alone). Approved refunds are processed within 7 working days to your original payment method. Opened or partly consumed products can only be returned if they were defective on delivery.',
    links: [{ label: 'Returns & Refunds Policy', url: `${SITE}/policies/returns-refunds` }],
  },
  {
    id: 'clean',
    words: ['maida', 'refined', 'sugar', 'preservative', 'chemical', 'toxin', 'clean label', 'healthy', 'natural', 'oil', 'artificial'],
    reply: 'Our products are made without maida, refined sugar, refined oil or artificial preservatives, using traditional slow-baking. Our cookies use millets or heritage rice with dairy butter and country sugar. Ask me about any product to see its key ingredients.',
    links: [{ label: 'Quality & Food Safety', url: `${SITE}/policies/quality-guidelines` }],
  },
  {
    id: 'fssai',
    words: ['fssai', 'license', 'licence', 'certified', 'certificate', 'food safety', 'hygiene', 'organic'],
    reply: 'Alimenture Industries Private Limited is registered under the Food Safety and Standards Act, 2006 (FSSAI), for Bakery Products and Ready-to-Eat Savouries; the registration is valid until 31 March 2029. Batches are prepared in FSSAI-compliant facilities.',
    links: [{ label: 'Quality & Food Safety', url: `${SITE}/policies/quality-guidelines` }],
  },
  {
    id: 'storage',
    words: ['shelf life', 'expiry', 'expire', 'best before', 'store', 'storage', 'how long last', 'fresh'],
    reply: 'Best-before / expiry details are printed on each pack. Please store products as directed on the pack — sealed, in a cool, dry place — to keep them at their best.',
    links: [{ label: 'Quality & Food Safety', url: `${SITE}/policies/quality-guidelines` }],
  },
  {
    id: 'about',
    words: ['about', 'founder', 'founded', 'who are you', 'company', 'story', 'located', 'location', 'where are you', 'chennai', 'nammalvar'],
    reply: 'Alimenture Industries Private Limited was incorporated in Chennai in December 2023 by Pavin Saminathan and Magesh Mohan. Inspired by Nammalvar, we make clean, wholesome food from heritage grains — baked in Chennai and delivered across India.',
    links: [{ label: 'Our story', url: `${SITE}/#story` }],
  },
  {
    id: 'catalogue',
    words: ['catalogue', 'catalog', 'brochure', 'pdf', 'price list'],
    reply: 'You can download our full product catalogue (PDF) from the homepage — just share your name and mobile number in the "Download our product catalogue" section.',
    links: [{ label: 'Get the catalogue', url: `${SITE}/#catalogue` }],
  },
  {
    id: 'coupon',
    words: ['coupon', 'discount', 'offer', 'promo', 'code', 'sale', 'deal'],
    reply: 'Current savings are shown on each product (the struck-out MRP). If you have a coupon code, apply it in your cart or at checkout before paying.',
    links: [{ label: 'Shop all products', url: `${SITE}/shop` }],
  },
  {
    id: 'bulk',
    words: ['bulk', 'wholesale', 'corporate', 'gift', 'gifting', 'distributor', 'dealer', 'reseller', 'large order'],
    reply: `For bulk, corporate gifting or distribution enquiries, please talk to our team — call ${CONTACT.phones.join(' / ')} or email ${CONTACT.email}.`,
    handoff: true,
  },
  {
    id: 'health',
    words: ['diabetic', 'diabetes', 'sugar patient', 'pregnant', 'pregnancy', 'baby', 'toddler', 'kid', 'child', 'weight loss', 'allergy', 'allergic', 'gluten', 'nut allergy', 'medical', 'doctor'],
    reply: "I can't give medical or dietary advice, but I can show you each product's key ingredients so you can check them — many of our recipes contain dairy butter and nuts. For specific health conditions or allergies, please check with your doctor. Ask me about any product by name.",
  },
];

// Ingredient groups the assistant can filter by (matched as whole words).
const INGREDIENTS = {
  nuts: ['nut', 'nuts', 'almond', 'cashew', 'pistachio', 'hazelnut', 'peanut'],
  millets: ['millet', 'ragi', 'sorghum', 'foxtail', 'barnyard', 'pearl'],
  'heritage rice': ['samba', 'kaattuyaanam', 'karunguruvai', 'rice'],
  coconut: ['coconut'], cocoa: ['cocoa', 'chocolate'], butter: ['butter'], seeds: ['seed', 'seeds'],
  'country sugar': ['country sugar', 'jaggery'], banana: ['banana'],
};

// ─── intents ─────────────────────────────────────────────────────────────────

const ORDER_STATUS_LABEL = {
  pending: 'Confirmed', payment_pending: 'Awaiting payment', processing: 'Being prepared', packed: 'Packed',
  shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded',
};

async function orderAnswer(user) {
  if (!user) {
    return {
      reply: 'Please sign in and I can show your latest order status here. You can also track every order from the Orders page.',
      links: [{ label: 'Sign in', url: `${SITE}/login` }, { label: 'Track orders', url: `${SITE}/orders` }],
      suggestions: ['Delivery charges & time', 'Talk to a specialist'],
    };
  }
  const snap = await db.collection('orders').where('userId', '==', user.uid).limit(20).get();
  const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?._seconds || b.createdAt?.seconds || 0) - (a.createdAt?._seconds || a.createdAt?.seconds || 0))
    .slice(0, 3);
  if (!orders.length) {
    return { reply: "I couldn't find any orders on your account yet.", links: [{ label: 'Shop now', url: `${SITE}/shop` }] };
  }
  const lines = orders.map((o) => {
    const st = ORDER_STATUS_LABEL[String(o.status || '').toLowerCase()] || o.status;
    const awb = o.shipment?.awb ? ` · ${o.shipment.courierName || 'Courier'} AWB ${o.shipment.awb}` : '';
    return `• #${o.id.slice(-8).toUpperCase()} — ${st}, ${money(o.totalAmount)}${awb}`;
  });
  return {
    reply: `Here are your latest orders:\n${lines.join('\n')}`,
    links: [{ label: 'Open order tracking', url: `${SITE}/orders` }],
    suggestions: ['Return a damaged item', 'Talk to a specialist'],
  };
}

async function deliveryAnswer(pincode) {
  const s = await delivery.getGlobalSettings();
  const free = s.freeDeliveryEnabled ? ` Delivery is free on orders above ${money(s.freeDeliveryThreshold)}.` : '';
  if (pincode) {
    const o = await delivery.resolveDeliveryOptions({ pincode });
    if (!o.pincode) return { reply: `${pincode} doesn't look like a valid 6-digit PIN code.` };
    if (!o.deliveryAvailable) {
      return { reply: `Sorry, we can't deliver to ${pincode} right now${o.reason ? ` — ${o.reason}` : ''}.`, suggestions: ['Talk to a specialist'] };
    }
    const place = [o.city, o.state].filter(Boolean).join(', ');
    const fast = o.fastest?.available ? `\nFastest delivery: ${o.fastest.fee ? money(o.fastest.fee) : 'free'}, ${o.fastest.eta}.` : '';
    return {
      reply: `Yes, we deliver to ${pincode}${place ? ` (${place})` : ''}.\nStandard delivery: from ${o.standard.fee ? money(o.standard.fee) : 'free'} for a small parcel, ${o.standard.eta}. The exact fee depends on your cart's weight and is shown at checkout.${fast}${free}`,
      suggestions: ['What products do you have?', 'Payment options'],
    };
  }
  return {
    reply: `Delivery is charged at our courier partner's rate for your parcel's weight and PIN code (from ${money(s.courierFeeBands?.[0]?.fee ?? s.defaultDeliveryFee)}), shown at checkout before you pay. It usually takes ${s.defaultStandardEta}.${free} We dispatch from Chennai within 1–2 working days through Shiprocket's courier partners, and you get a tracking (AWB) number once shipped.\n\nSend me your 6-digit PIN code and I'll check delivery to you.`,
    links: [{ label: 'Shipping Policy', url: `${SITE}/policies/shipping-policy` }],
  };
}

function catalogueOverview(products) {
  const byCat = new Map();
  for (const p of products) {
    const c = p.category || 'Products';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(p);
  }
  const lines = [...byCat].map(([c, items]) => `• ${c}: ${items.map((p) => p.name).join(', ')}`);
  return {
    reply: `We currently have ${products.length} products:\n${lines.join('\n')}\n\nAsk me about any of them for price and ingredients.`,
    links: [{ label: 'Shop all products', url: `${SITE}/shop` }],
    suggestions: [...byCat.keys()].slice(0, 3).map((c) => `Show ${c.toLowerCase()}`),
  };
}

/**
 * @param {string} message
 * @param {{ uid:string }|null} user   signed-in user (for order lookups), or null
 * @returns {Promise<{ reply:string, products?:object[], links?:object[], suggestions:string[], handoff:boolean }>}
 */
async function answer(message, user) {
  const raw = String(message || '').slice(0, 500);
  const text = norm(raw);
  const out = (r) => ({ products: [], links: [], handoff: false, ...r, suggestions: r.suggestions || DEFAULT_SUGGESTIONS });

  if (!text) return out({ reply: 'Ask me anything about our products, delivery, payments or your order.' });

  if (/^(hi|hello|hey|hii+|vanakkam|namaste|good (morning|afternoon|evening))\b/.test(text) && text.split(' ').length <= 4) {
    return out({ reply: "Hi! I'm the Alimenture assistant. I can help with products, prices, ingredients, delivery, payments, returns and your orders. What would you like to know?" });
  }
  if (has(text, ['thank', 'thanks', 'great', 'ok thanks', 'bye'])) {
    return out({ reply: "You're welcome! Anything else I can help with?" });
  }
  if (has(text, ['human', 'agent', 'person', 'specialist', 'executive', 'representative', 'talk to', 'speak to', 'call me', 'customer care', 'support team', 'contact', 'phone', 'email'])) {
    return out({
      reply: `Sure — you can chat with a specialist here (sign-in needed), or reach us on ${CONTACT.phones.join(' / ')} or ${CONTACT.email}.`,
      handoff: true,
      suggestions: ['Where is my order?', 'Return a damaged item'],
    });
  }

  // Policy topics first, so "cancel my order" / "cash on delivery" don't get
  // routed to order tracking or delivery fees.
  const policy = POLICY_ANSWERS
    .map((f) => ({ f, hits: f.words.filter((w) => has(text, [w])).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)[0];
  const policyFirst = policy && ['cancel', 'returns', 'payment'].includes(policy.f.id);

  const pin = (raw.match(/\b[1-9]\d{5}\b/) || [])[0];
  if (pin || has(text, ['pincode', 'pin code', 'deliver to', 'serviceable', 'delivery available'])) {
    return out(await deliveryAnswer(pin));
  }
  if (policyFirst) return out({ reply: policy.f.reply, links: policy.f.links || [], handoff: !!policy.f.handoff });
  if (has(text, ['where is my order', 'my order', 'order status', 'track', 'tracking', 'awb', 'not received', 'not delivered', 'when will i get', 'when will my'])) {
    return out(await orderAnswer(user));
  }

  const products = await catalogue();
  const catHit = [...new Set(products.map((p) => p.category))].find((c) => c && has(text, [norm(c).replace(/s$/, '')]));

  // Ingredient filters ("cookies with nuts", "products without nuts"). Whole-word
  // matching so "nut" never matches "coconut" — this answers allergy questions.
  const ingHit = Object.entries(INGREDIENTS).find(([key, words]) => has(text, [key.replace(/s$/, ''), ...words]));
  const filterQ = has(text, ['with', 'which', 'contain', 'containing', 'have', 'has', 'without', 'no', 'free', 'made', 'products', 'items', 'any']);
  if (ingHit && filterQ) {
    const [label, words] = ingHit;
    const exclude = /\b(without|no|free|avoid|except|not)\b/.test(text) || new RegExp(`${words[0]}\\s*free`).test(text);
    const hasIng = (p) => words.some((w) => new RegExp(`\\b${w}`).test(p.searchText));
    const pool = catHit ? products.filter((p) => p.category === catHit) : products;
    const items = pool.filter((p) => (exclude ? !hasIng(p) : hasIng(p)));
    const what = catHit ? catHit.toLowerCase() : 'products';
    const note = label === 'nuts' || exclude
      ? '\n\nThis is based on each product\'s listed key ingredients — please always check the pack label for full allergen information.'
      : '';
    if (items.length) {
      const noun = items.length === 1 ? what.replace(/s$/, '') : what;
      const head = exclude
        ? `${items.length} ${noun} ${items.length === 1 ? "doesn't" : "don't"} list ${label} in ${items.length === 1 ? 'its' : 'their'} key ingredients:`
        : `${items.length} ${noun} made with ${label}:`;
      return out({ reply: `${head}${note}`, products: items.slice(0, 6).map(card) });
    }
    return out({ reply: `I couldn't find ${what} ${exclude ? 'without' : 'with'} ${label} in our current range.${note}`, suggestions: ['What products do you have?'] });
  }

  // A specific product (or a few close ones) by name / ingredient / category.
  const ranked = scoreProducts(products, text);
  const top = ranked[0];
  if (top && top.nameHits >= 1 && top.nameRatio >= 0.5 && (!ranked[1] || ranked[1].score < top.score)) {
    const p = top.p;
    const related = products.filter((o) => o.id !== p.id && o.category === p.category).slice(0, 2);
    return out({
      reply: productDetail(p),
      products: [card(p)],
      suggestions: [...related.map((o) => `Tell me about ${o.name}`), 'Delivery charges & time'],
    });
  }

  const strong = ranked.filter((r) => r.nameRatio >= 0.66);
  if (strong.length >= 2) {
    return out({ reply: 'We have a few of those:', products: strong.slice(0, 4).map((r) => card(r.p)) });
  }

  // Policy / FAQ topics.
  const deliveryQ = has(text, ['delivery', 'deliver', 'shipping', 'ship', 'courier', 'dispatch', 'how many days', 'how long', 'charges', 'free delivery']);
  if (deliveryQ && !(policy && ['returns', 'cancel'].includes(policy.f.id))) return out(await deliveryAnswer(null));
  if (policy) return out({ reply: policy.f.reply, links: policy.f.links || [], handoff: !!policy.f.handoff });

  // Category browsing, best-sellers, full list.
  if (catHit) {
    const items = products.filter((p) => p.category === catHit);
    return out({ reply: `Here's our ${catHit.toLowerCase()} range (${items.length}):`, products: items.slice(0, 6).map(card), links: [{ label: `View all ${catHit}`, url: `${SITE}/categories/${norm(catHit).replace(/\s+/g, '-')}` }] });
  }
  if (has(text, ['best', 'bestseller', 'best seller', 'popular', 'recommend', 'suggest', 'favourite', 'favorite', 'top'])) {
    const picks = (products.filter((p) => p.featured).length ? products.filter((p) => p.featured) : products).slice(0, 4);
    return out({ reply: 'Here are our featured favourites:', products: picks.map(card) });
  }
  if (has(text, ['product', 'products', 'sell', 'menu', 'range', 'items', 'what do you have', 'available', 'list', 'show'])) {
    return out(catalogueOverview(products));
  }
  if (ranked.length) {
    const items = ranked.slice(0, 4).map((r) => r.p);
    return out({ reply: items.length === 1 ? productDetail(items[0]) : 'These products match what you asked about:', products: items.map(card) });
  }

  return out({
    reply: "I'm not sure about that one. I can answer questions about our products, prices, ingredients, delivery, payments, returns and your orders — or connect you with a specialist.",
    handoff: true,
  });
}

module.exports = { answer };
