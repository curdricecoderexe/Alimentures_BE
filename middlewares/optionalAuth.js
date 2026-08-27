/**
 * optionalAuth — attach req.user IF a valid Firebase token is present, but do
 * NOT reject the request when it is absent or invalid. Lets a public endpoint
 * return a richer/unfiltered payload to staff while staying open to anonymous
 * visitors.
 */
'use strict';

const { verifyIdToken, extractBearer } = require('../utils/firebaseAuth');

module.exports = async function optionalAuth(req, res, next) {
  const token = extractBearer(req.headers.authorization);
  if (!token) return next();
  try {
    req.user = await verifyIdToken(token);
  } catch {
    // ignore — treat as anonymous
  }
  next();
};
