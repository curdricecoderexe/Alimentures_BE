'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/appearanceController');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const imageField = require('../middlewares/imageField');
const { writeLimiter } = require('../middlewares/rateLimiters');

// Public — storefront reads the background map.
router.get('/', ctrl.getAppearance);

// Admin.
router.get('/slots', verifyToken, isAdmin, ctrl.getSlots);
router.put('/:key', verifyToken, isAdmin, writeLimiter, imageField(['image']), ctrl.updateAsset);
router.delete('/:key', verifyToken, isAdmin, writeLimiter, ctrl.deleteAsset);

module.exports = router;
