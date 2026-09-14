'use strict';

const log = require('./logger');

/**
 * Run a Firestore query that ends in `.orderBy(orderField, dir).limit(n)`, but
 * fall back gracefully when the required composite index has not been deployed
 * yet (error code 9 / FAILED_PRECONDITION). In the fallback we re-run the same
 * filters WITHOUT the orderBy (so only auto single-field indexes are needed),
 * then sort + trim in memory.
 *
 * Cursor pagination (`startAfter`) is only applied on the fast path; the
 * fallback returns the first `limit` docs by `orderField` and callers should
 * treat it as best-effort until indexes finish building.
 *
 * @param {FirebaseFirestore.Query} orderedQuery  filters + orderBy + limit already applied
 * @param {FirebaseFirestore.Query} filteredQuery same filters, NO orderBy (limit optional)
 * @param {{ orderField: string, dir?: 'asc'|'desc', limit: number, requestId?: string }} opts
 * @returns {Promise<FirebaseFirestore.QueryDocumentSnapshot[]>}
 */
async function runOrdered(orderedQuery, filteredQuery, { orderField, dir = 'desc', limit, requestId } = {}) {
  try {
    const snap = await orderedQuery.get();
    return snap.docs;
  } catch (err) {
    if (err.code !== 9) throw err;
    log.warn('query.index_missing_fallback', { requestId, orderField });

    const snap = await filteredQuery.get();
    const ms = (v) =>
      v?.toMillis ? v.toMillis() : (v?._seconds ? v._seconds * 1000 : 0);
    const sorted = snap.docs.sort((a, b) => {
      const d = ms(a.get(orderField)) - ms(b.get(orderField));
      return dir === 'desc' ? -d : d;
    });
    return typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
  }
}

module.exports = { runOrdered };
