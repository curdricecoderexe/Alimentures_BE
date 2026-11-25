/**
 * Tiny in-memory read-through cache for Firestore-backed responses.
 *
 *   const cache = memoCache({ ttlMs: 5 * 60 * 1000 });
 *   const data = await cache.get('key', () => loadFromFirestore());
 *   cache.clear();            // after an admin write
 *
 * - Concurrent misses for the same key share one load (no thundering herd).
 * - A failed load is not cached; a stale value is served if one exists, so a
 *   brief Firestore outage (or quota exhaustion) doesn't blank the storefront.
 * - Single-process only (PM2 runs one instance — see deploy/ecosystem.config.js).
 */
module.exports = function memoCache({ ttlMs = 5 * 60 * 1000, maxKeys = 500 } = {}) {
  const store = new Map(); // key -> { value, at }
  const pending = new Map(); // key -> Promise

  async function get(key, loader) {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    if (pending.has(key)) return pending.get(key);

    const p = (async () => {
      try {
        const value = await loader();
        if (store.size >= maxKeys && !store.has(key)) store.delete(store.keys().next().value);
        store.set(key, { value, at: Date.now() });
        return value;
      } catch (err) {
        if (hit) return hit.value; // stale beats an error page
        throw err;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, p);
    return p;
  }

  return {
    get,
    clear: (key) => (key === undefined ? store.clear() : store.delete(key)),
    size: () => store.size,
  };
};
