const express = require('express');
const router = express.Router();
const cartController = require('../controllers/cartController');
const { analyticsLimiter } = require('../middlewares/rateLimiters');

// Public cart pricing/stock check — rate-limited (does several Firestore reads).
router.post('/validate', analyticsLimiter, cartController.validateCart);

module.exports = router;
