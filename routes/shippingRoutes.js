/**
 * shippingRoutes.js — Shiprocket fulfilment + tracking.
 *
 * NOTE: Shiprocket rejects webhook URLs containing "shiprocket", "kartrocket",
 * "sr" or "kr", which is why this router is mounted at /api/shipping and the
 * webhook lives at /api/shipping/webhook.
 */
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/shippingController');
const verifyToken = require('../middlewares/verifyToken');
const isStaff = require('../middlewares/isStaff');
const { writeLimiter } = require('../middlewares/rateLimiters');

// Shiprocket → us (token-authenticated inside the handler)
router.post('/webhook', ctrl.webhook);

// Customer (own order) / staff
router.get('/track/:id', verifyToken, writeLimiter, ctrl.getTracking);

// Staff fulfilment
router.get('/status', verifyToken, isStaff, ctrl.getStatus);
router.post('/orders/:id/create', verifyToken, isStaff, writeLimiter, ctrl.createShipment);
router.get('/orders/:id/couriers', verifyToken, isStaff, writeLimiter, ctrl.getCouriers);
router.post('/orders/:id/ship', verifyToken, isStaff, writeLimiter, ctrl.shipOrder);
router.post('/orders/:id/sync', verifyToken, isStaff, writeLimiter, ctrl.syncTracking);

module.exports = router;
