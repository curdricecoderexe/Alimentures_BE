const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/analyticsController');
const { analyticsLimiter, analyticsDailyLimiter } = require('../middlewares/rateLimiters');

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
router.get('/ping', ctrl.ping);

// ─── PUBLIC INGESTION (no auth — data from visitors) ──────────────────────────
// Per-minute burst limit + a hard per-IP daily cap on top.
const ingestLimits = [analyticsDailyLimiter, analyticsLimiter];
router.post('/pageview',     ingestLimits, ctrl.ingestPageview);
router.post('/event',        ingestLimits, ctrl.ingestEvent);
router.post('/session',      ingestLimits, ctrl.ingestSession);
router.post('/consent',      ingestLimits, ctrl.ingestConsent);
router.post('/performance',  ingestLimits, ctrl.ingestPerformance);

// ─── ADMIN READS ──────────────────────────────────────────────────────────────
const verifyToken = require('../middlewares/verifyToken');
const isAdmin = require('../middlewares/isAdmin');

router.get('/overview',        verifyToken, isAdmin, ctrl.getOverview);
router.get('/pageviews',       verifyToken, isAdmin, ctrl.getPageviews);
router.get('/events',          verifyToken, isAdmin, ctrl.getEvents);
router.get('/consent-stats',   verifyToken, isAdmin, ctrl.getConsentStats);
router.get('/devices',         verifyToken, isAdmin, ctrl.getDevices);
router.get('/traffic-sources', verifyToken, isAdmin, ctrl.getTrafficSources);
router.get('/performance',     verifyToken, isAdmin, ctrl.getPerformance);
router.get('/active-visitors', verifyToken, isAdmin, ctrl.getActiveVisitors);

// ─── ADMIN SALES ANALYTICS ────────────────────────────────────────────────────
router.get('/sales-overview',  verifyToken, isAdmin, ctrl.getSalesOverview);
router.get('/sales-trend',     verifyToken, isAdmin, ctrl.getSalesTrend);
router.get('/top-products',    verifyToken, isAdmin, ctrl.getTopProducts);
router.get('/category-dist',   verifyToken, isAdmin, ctrl.getCategoryDistribution);

module.exports = router;
