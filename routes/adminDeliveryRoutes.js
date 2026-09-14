/**
 * adminDeliveryRoutes.js — admin PIN-code delivery management.
 * All routes: verifyToken → isAdmin → writeLimiter.
 */
const express = require('express');
const router = express.Router();

const ctrl = require('../controllers/adminDeliveryController');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const { writeLimiter } = require('../middlewares/rateLimiters');

router.use(verifyToken, isAdmin, writeLimiter);

// summary + settings
router.get('/summary', ctrl.getSummary);
router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);

// CSV
router.get('/pincodes/export', ctrl.exportCsv);
router.post('/pincodes/import', ctrl.importCsv);

// bulk
router.post('/pincodes/bulk', ctrl.bulkAction);

// CRUD
router.get('/pincodes', ctrl.listPincodes);
router.post('/pincodes', ctrl.createPincode); // single OR { items: [...] }
router.put('/pincodes/:pincode', ctrl.updatePincode);
router.patch('/pincodes/:pincode/status', ctrl.setStatus);
router.delete('/pincodes/:pincode', ctrl.deletePincode);

module.exports = router;
