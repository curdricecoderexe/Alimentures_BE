const db = require('../config/firebase');
const admin = require('firebase-admin');

/**
 * Sales analytics use SHARDED counters so a burst of concurrent checkouts does
 * not all contend on one hot document (Firestore's ~1 sustained write/sec/doc
 * limit was a checkout throughput ceiling — see audit M-17).
 *
 * Each rollup ("global overview", a given day, a given month) is spread across
 * SHARDS documents named `<key>__s<n>`. Writers pick a random shard; readers sum
 * all shards via `sumShards()`.
 */
const SHARDS = 10;

const IST_OFFSET = 5.5 * 60 * 60 * 1000;
function istKeys() {
  const now = new Date(Date.now() + IST_OFFSET);
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  return { dateStr, monthStr: dateStr.slice(0, 7) };
}

const shardRef = (collection, key) =>
  db.collection(collection).doc(`${key}__s${Math.floor(Math.random() * SHARDS)}`);

/** Numeric fields that should be summed when reading a rollup. */
const NUMERIC_FIELDS = [
  'revenue', 'orderCount', 'paidOrderCount', 'unitsSold',
  'razorpayRevenue', 'codRevenue', 'cancelledOrderCount',
];

/**
 * Read a sharded rollup and return the summed totals.
 * @returns {Promise<Object>} e.g. { revenue, orderCount, ... }
 */
async function sumShards(collection, key) {
  const refs = Array.from({ length: SHARDS }, (_, n) => db.collection(collection).doc(`${key}__s${n}`));
  const docs = await db.getAll(...refs);
  const totals = Object.fromEntries(NUMERIC_FIELDS.map((f) => [f, 0]));
  for (const d of docs) {
    if (!d.exists) continue;
    const data = d.data();
    for (const f of NUMERIC_FIELDS) totals[f] += Number(data[f] || 0);
  }
  return totals;
}

function buildDelta(orderData, paymentMethod, sign) {
  const revenue = (Number(orderData.totalAmount) || 0) * sign;
  const units = (orderData.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0) * sign;
  const isRazorpay = paymentMethod === 'razorpay';
  const isCOD = paymentMethod === 'cod';
  const inc = admin.firestore.FieldValue.increment;
  return {
    revenue: inc(revenue),
    unitsSold: inc(units),
    razorpayRevenue: inc(isRazorpay ? revenue : 0),
    codRevenue: inc(isCOD ? revenue : 0),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function writeProductRollups(t, items, sign) {
  for (const item of items || []) {
    const productId = item.productId || 'unknown';
    const qty = (Number(item.quantity) || 0) * sign;
    const rev = (Number(item.price) || 0) * (Number(item.quantity) || 0) * sign;
    t.set(db.collection('analytics_products_lifetime').doc(productId), {
      name: item.name || item.title || 'Unknown Product',
      category: item.category || 'General',
      unitsSold: admin.firestore.FieldValue.increment(qty),
      revenue: admin.firestore.FieldValue.increment(rev),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}

/**
 * Increment sales analytics. MUST be called inside a Firestore transaction.
 */
exports.incrementSalesAnalytics = (t, orderData, paymentMethod) => {
  const { dateStr, monthStr } = istKeys();
  const delta = buildDelta(orderData, paymentMethod, 1);
  delta.orderCount = admin.firestore.FieldValue.increment(1);
  delta.paidOrderCount = admin.firestore.FieldValue.increment(1);

  t.set(shardRef('analytics_sales_global', 'overview'), delta, { merge: true });
  t.set(shardRef('analytics_sales_daily', dateStr), delta, { merge: true });
  t.set(shardRef('analytics_sales_monthly', monthStr), delta, { merge: true });

  writeProductRollups(t, orderData.items, 1);
};

/**
 * Reverse sales analytics for a cancellation / refund. Inside a transaction.
 */
exports.decrementSalesAnalytics = (t, orderData, paymentMethod) => {
  const { dateStr, monthStr } = istKeys();
  const delta = buildDelta(orderData, paymentMethod, -1);
  delta.cancelledOrderCount = admin.firestore.FieldValue.increment(1);

  t.set(shardRef('analytics_sales_global', 'overview'), delta, { merge: true });
  t.set(shardRef('analytics_sales_daily', dateStr), delta, { merge: true });
  t.set(shardRef('analytics_sales_monthly', monthStr), delta, { merge: true });

  writeProductRollups(t, orderData.items, -1);
};

exports.sumShards = sumShards;
exports.SHARDS = SHARDS;
