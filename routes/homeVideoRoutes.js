'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/homeVideoController');
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');
const { validate } = require('../middlewares/validate');
const { writeLimiter } = require('../middlewares/rateLimiters');
const { LIMITS } = require('../config/constants');

// Raw bytes, parsed only after auth so anonymous uploads are never buffered.
const rawVideo = express.raw({ type: ['video/mp4', 'video/webm', 'video/quicktime'], limit: LIMITS.VIDEO_MAX_BYTES });

// Public — storefront reads the copy, then streams the film.
router.get('/', ctrl.getHomeVideo);
router.get('/stream', ctrl.streamHomeVideo);

// Admin.
router.patch('/', verifyToken, isAdmin, writeLimiter, validate({
  body: {
    title: { type: 'string', trim: true, max: 120 },
    subtitle: { type: 'string', trim: true, max: 280 },
    enabled: { type: 'boolean' },
  },
}), ctrl.updateHomeVideoDetails);
router.put('/file', verifyToken, isAdmin, writeLimiter, rawVideo, ctrl.uploadHomeVideo);
router.delete('/file', verifyToken, isAdmin, writeLimiter, ctrl.deleteHomeVideo);

module.exports = router;
