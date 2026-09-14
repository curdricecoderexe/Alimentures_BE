/**
 * deliveryRoutes.js — customer-facing delivery + India location endpoints.
 * Read-only, public, rate-limited (each hits Firestore).
 */
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/deliveryController');
const { writeLimiter } = require('../middlewares/rateLimiters');

// A light per-IP/user limiter reusing the generic write bucket is plenty for
// these cheap reads and stops pincode enumeration scripts.
router.get('/locations/states', ctrl.getStates);
router.get('/locations/cities', ctrl.getCities);
router.get('/pincode/:pincode', writeLimiter, ctrl.getPincodeInfo);
router.get('/options/:pincode', writeLimiter, ctrl.getDeliveryOptions);

module.exports = router;
