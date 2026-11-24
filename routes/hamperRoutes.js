const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router = express.Router();
const ctrl = require('../controllers/hamperEnquiryController');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const { validate } = require('../middlewares/validate');

// A handful of enquiries per IP is plenty for real visitors.
const enquiryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, error: 'Too many requests. Please try again in a few minutes.' },
});

// Public — bulk / corporate hamper enquiry
router.post('/enquiries', enquiryLimiter, validate({
  body: {
    name: { type: 'string', trim: true, max: 80, required: true },
    mobile: { type: 'string', trim: true, max: 20, required: true },
    email: { type: 'string', trim: true, max: 120 },
    company: { type: 'string', trim: true, max: 120 },
    hamper: { type: 'string', trim: true, max: 120 },
    quantity: { type: 'integer', min: 1, max: 100000, required: true },
    occasion: { type: 'string', trim: true, max: 60 },
    deliveryDate: { type: 'string', trim: true, pattern: /^\d{4}-\d{2}-\d{2}$/ },
    city: { type: 'string', trim: true, max: 120 },
    branding: { type: 'boolean' },
    budget: { type: 'string', trim: true, max: 40 },
    notes: { type: 'string', trim: true, max: 1500 },
  },
}), ctrl.createEnquiry);

// Admin
router.get('/enquiries', verifyToken, isAdmin, ctrl.listEnquiries);
router.patch('/enquiries/:id', verifyToken, isAdmin, validate({
  body: { status: { type: 'enum', values: ctrl.STATUSES, required: true } },
}), ctrl.updateEnquiry);
router.delete('/enquiries/:id', verifyToken, isAdmin, ctrl.deleteEnquiry);

module.exports = router;
