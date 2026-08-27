/**
 * rateLimiters.js — named express-rate-limit instances.
 *
 * `app.set('trust proxy', 1)` MUST be set in index.js for these to key on the
 * real client IP behind Render's proxy. Authenticated limiters additionally key
 * on the uid so one abusive account can't exhaust a shared IP bucket and vice
 * versa.
 */

'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const MIN = 60 * 1000;

const json = (msg) => ({ success: false, error: msg });

const base = {
  standardHeaders: true,
  legacyHeaders: false,
};

// ipKeyGenerator normalises IPv6 addresses to a /56 block so users can't rotate
// within their prefix to bypass a limit.
const ipKey = (req) => ipKeyGenerator(req.ip);
const userOrIpKey = (req) => (req.user && req.user.uid ? `u:${req.user.uid}` : `ip:${ipKeyGenerator(req.ip)}`);
const emailIpKey = (req) => {
  const email = (req.body && typeof req.body.email === 'string') ? req.body.email.toLowerCase().trim() : '';
  return `${email}|${ipKeyGenerator(req.ip)}`;
};

/** Login / register / generic auth — keyed by email+IP so credential stuffing across accounts still trips it. */
const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * MIN,
  max: 20,
  keyGenerator: emailIpKey,
  message: json('Too many attempts. Please wait and try again.'),
});

/** OTP send / verify — tighter, separate bucket from password login. */
const otpLimiter = rateLimit({
  ...base,
  windowMs: 15 * MIN,
  max: 8,
  keyGenerator: emailIpKey,
  message: json('Too many OTP requests. Please wait 15 minutes.'),
});

/** Order creation + payment verification. */
const orderLimiter = rateLimit({
  ...base,
  windowMs: 5 * MIN,
  max: 15,
  keyGenerator: userOrIpKey,
  message: json('Too many order requests. Please slow down.'),
});

/** Coupon validation — prevents code brute-forcing / enumeration. */
const couponLimiter = rateLimit({
  ...base,
  windowMs: 10 * MIN,
  max: 30,
  keyGenerator: userOrIpKey,
  message: json('Too many coupon attempts. Please wait.'),
});

const reviewLimiter = rateLimit({
  ...base,
  windowMs: 10 * MIN,
  max: 20,
  keyGenerator: userOrIpKey,
  message: json('Too many review submissions. Please wait.'),
});

const chatLimiter = rateLimit({
  ...base,
  windowMs: 5 * MIN,
  max: 20,
  keyGenerator: userOrIpKey,
  message: json('Too many chat requests. Please wait.'),
});

/** Public analytics ingestion — tight per-IP; the endpoints each do a Firestore write. */
const analyticsLimiter = rateLimit({
  ...base,
  windowMs: MIN,
  max: 60,
  keyGenerator: ipKey,
  message: json('Rate limit exceeded.'),
});

/** Hard per-IP daily cap on analytics ingestion (defence against slow, sustained
 *  write-inflation that the per-minute limiter alone doesn't stop). In-memory
 *  per instance, but zero Firestore cost. */
const analyticsDailyLimiter = rateLimit({
  ...base,
  windowMs: 24 * 60 * MIN,
  max: Number(process.env.ANALYTICS_DAILY_MAX) || 2000,
  keyGenerator: ipKey,
  message: json('Daily analytics limit reached.'),
});

/** Generic authenticated write limiter for content/admin mutation endpoints. */
const writeLimiter = rateLimit({
  ...base,
  windowMs: 5 * MIN,
  max: 100,
  keyGenerator: userOrIpKey,
  message: json('Too many requests. Please slow down.'),
});

module.exports = {
  authLimiter,
  otpLimiter,
  orderLimiter,
  couponLimiter,
  reviewLimiter,
  chatLimiter,
  analyticsLimiter,
  analyticsDailyLimiter,
  writeLimiter,
};
