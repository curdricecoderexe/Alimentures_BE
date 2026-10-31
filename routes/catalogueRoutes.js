'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const router = express.Router();
const ctrl = require('../controllers/catalogueController');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const { validate } = require('../middlewares/validate');
const { writeLimiter } = require('../middlewares/rateLimiters');
const { LIMITS } = require('../config/constants');

// Lead form: a handful of submissions per IP is plenty for real visitors.
const leadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { success: false, error: 'Too many requests. Please try again in a few minutes.' },
});

const rawPdf = express.raw({ type: 'application/pdf', limit: LIMITS.CATALOGUE_MAX_BYTES });

// Public.
router.get('/', ctrl.getCatalogue);
router.post('/leads', leadLimiter, validate({
  body: {
    name: { type: 'string', trim: true, max: 60, required: true },
    mobile: { type: 'string', trim: true, max: 20, required: true },
  },
}), ctrl.submitLead);
router.get('/file', ctrl.downloadFile);

// Admin.
router.get('/admin', verifyToken, isAdmin, ctrl.getAdminCatalogue);
router.patch('/admin', verifyToken, isAdmin, writeLimiter, validate({
  body: {
    title: { type: 'string', trim: true, max: 100 },
    description: { type: 'string', trim: true, max: 300 },
    enabled: { type: 'boolean' },
  },
}), ctrl.updateDetails);
router.put('/admin/file', verifyToken, isAdmin, writeLimiter, rawPdf, ctrl.uploadFile);
router.delete('/admin/file', verifyToken, isAdmin, writeLimiter, ctrl.deleteFile);
router.get('/admin/leads', verifyToken, isAdmin, ctrl.listLeads);
router.delete('/admin/leads/:id', verifyToken, isAdmin, writeLimiter, ctrl.deleteLead);

module.exports = router;
