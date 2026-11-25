const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/analyticsController');
const { analyticsLimiter, analyticsDailyLimiter } = require('../middlewares/rateLimiters');
const responseCache = require('../middlewares/responseCache');

// Dashboard reads scan thousands of raw docs; numbers only need to be minutes-fresh.
const dash = responseCache(5 * 60 * 1000);
const live = responseCache(60 * 1000);

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

router.get('/overview',        verifyToken, isAdmin, dash, ctrl.getOverview);
router.get('/pageviews',       verifyToken, isAdmin, dash, ctrl.getPageviews);
router.get('/events',          verifyToken, isAdmin, dash, ctrl.getEvents);
router.get('/consent-stats',   verifyToken, isAdmin, dash, ctrl.getConsentStats);
router.get('/devices',         verifyToken, isAdmin, dash, ctrl.getDevices);
router.get('/traffic-sources', verifyToken, isAdmin, dash, ctrl.getTrafficSources);
router.get('/performance',     verifyToken, isAdmin, dash, ctrl.getPerformance);
router.get('/active-visitors', verifyToken, isAdmin, live, ctrl.getActiveVisitors);

// ─── ADMIN SALES ANALYTICS ────────────────────────────────────────────────────
router.get('/sales-overview',  verifyToken, isAdmin, dash, ctrl.getSalesOverview);
router.get('/sales-trend',     verifyToken, isAdmin, dash, ctrl.getSalesTrend);
router.get('/top-products',    verifyToken, isAdmin, dash, ctrl.getTopProducts);
router.get('/category-dist',   verifyToken, isAdmin, dash, ctrl.getCategoryDistribution);

module.exports = router;
