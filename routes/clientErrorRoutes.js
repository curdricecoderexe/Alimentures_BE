const express = require('express');
const router = express.Router();
const { rateLimit } = require('express-rate-limit');
const { report } = require('../controllers/clientErrorController');

// Public but tight — one client shouldn't be able to flood the error webhook.
const clientErrorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many error reports.' },
});

router.post('/', clientErrorLimiter, report);

module.exports = router;
