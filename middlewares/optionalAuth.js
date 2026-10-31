/**
 * optionalAuth — attach req.user IF a valid Firebase token is present, but do
 * NOT reject the request when it is absent or invalid. Lets a public endpoint
 * return a richer/unfiltered payload to staff while staying open to anonymous
 * visitors.
 */
'use strict';

const { authenticate } = require('../utils/firebaseAuth');

module.exports = async function optionalAuth(req, res, next) {
  try {
    const { user, via } = await authenticate({ authorization: req.headers.authorization, cookieHeader: req.headers.cookie, res });
    req.user = user;
    req.authVia = via;
  } catch {
    // ignore — treat as anonymous
  }
  next();
};
