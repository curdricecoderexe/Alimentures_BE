'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router = express.Router();
const ctrl = require('../controllers/newsletterController');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const { writeLimiter } = require('../middlewares/rateLimiters');

// Signup form: a few submissions per IP is plenty for real visitors.
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, error: 'Too many requests. Please try again in a few minutes.' },
});

// Public.
router.post('/', signupLimiter, ctrl.subscribe);
router.get('/unsubscribe', writeLimiter, ctrl.unsubscribe);
router.post('/unsubscribe', writeLimiter, ctrl.unsubscribe);

// Admin.
router.get('/admin', verifyToken, isAdmin, ctrl.listSubscribers);
router.delete('/admin/:id', verifyToken, isAdmin, writeLimiter, ctrl.deleteSubscriber);

module.exports = router;
