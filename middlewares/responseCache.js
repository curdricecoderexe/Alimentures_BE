/**
 * Cache successful JSON responses of read-only, non-personalised GET routes in
 * memory (keyed by URL). Used for the admin analytics dashboard, where one page
 * load fans out into several large Firestore scans and the numbers only need
 * to be minutes-fresh.
 */
module.exports = function responseCache(ttlMs, { maxKeys = 200 } = {}) {
  const store = new Map(); // url -> { body, at }
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const key = req.originalUrl;
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) {
      res.set('X-Cache', 'HIT');
      return res.status(200).json(hit.body);
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200 && body && body.success !== false) {
        if (store.size >= maxKeys && !store.has(key)) store.delete(store.keys().next().value);
        store.set(key, { body, at: Date.now() });
      }
      return json(body);
    };
    return next();
  };
};
