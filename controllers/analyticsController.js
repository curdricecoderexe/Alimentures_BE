const crypto = require('node:crypto');
const db = require('../config/firebase');
const { sumShards } = require('../services/analyticsService');

// Hard cap on how many raw analytics docs a single dashboard query will read, so
// a busy site can't turn one admin page load into tens of thousands of reads.
// When hit, the response carries `capped: true`. Real pre-aggregation is tracked
// separately; this is the interim bound.
const ANALYTICS_READ_CAP = 8000;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Derive an opaque, stable session doc id from the client-supplied sessionId so
// a client cannot target/overwrite another visitor's session document.
const sessionDocId = (raw) =>
  's_' + crypto.createHash('sha256')
    .update(`${String(raw || '').slice(0, 200)}:${process.env.RAZORPAY_WEBHOOK_SECRET || 'anon'}`)
    .digest('hex').slice(0, 40);

const getStartOf = (range) => {
  const now = new Date();
  if (range === 'today') return new Date(now.setHours(0, 0, 0, 0));
  if (range === '7d')    return new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
  if (range === '30d')   return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  if (range === '90d')   return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default 7d
};

const sanitize = (obj) => {
  const clean = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'string') clean[key] = v.slice(0, 500).replace(/[<>"']/g, '');
    else if (typeof v === 'number' || typeof v === 'boolean') clean[key] = v;
    else if (v === null || v === undefined) clean[key] = null;
    else clean[key] = String(v).slice(0, 200);
  }
  return clean;
};

exports.ping = (req, res) => {
  res.json({ success: true, message: 'Analytics API reachable', timestamp: Date.now() });
};

// ─── INGEST: PAGE VIEW ────────────────────────────────────────────────────────

exports.ingestPageview = async (req, res) => {
  try {
    const data = sanitize({
      url:         req.body.url         || '',
      title:       req.body.title       || '',
      referrer:    req.body.referrer    || '',
      sessionId:   req.body.sessionId   || '',
      visitorId:   req.body.visitorId   || '',
      device:      req.body.device      || 'desktop',
      browser:     req.body.browser     || '',
      os:          req.body.os          || '',
      utmSource:   req.body.utmSource   || '',
      utmMedium:   req.body.utmMedium   || '',
      utmCampaign: req.body.utmCampaign || '',
      timeOnPage:  Number(req.body.timeOnPage)  || 0,
      scrollDepth: Number(req.body.scrollDepth) || 0,
      timestamp:   Date.now(),
    });
    console.log('[Analytics] Pageview:', data.url, '| visitor:', data.visitorId?.slice(0, 12));
    await db.collection('analytics_pageviews').add(data);
    res.json({ success: true });
  } catch (e) {
    console.error('ingestPageview', e);
    res.status(500).json({ success: false });
  }
};

// ─── INGEST: EVENT ────────────────────────────────────────────────────────────

exports.ingestEvent = async (req, res) => {
  try {
    const data = sanitize({
      name:      req.body.name      || 'unknown',
      sessionId: req.body.sessionId || '',
      visitorId: req.body.visitorId || '',
      url:       req.body.url       || '',
      device:    req.body.device    || 'desktop',
      browser:   req.body.browser   || '',
      timestamp: Date.now(),
      ...( req.body.properties ? { properties: JSON.stringify(req.body.properties).slice(0, 500) } : {} ),
    });
    await db.collection('analytics_events').add(data);
    res.json({ success: true });
  } catch (e) {
    console.error('ingestEvent', e);
    res.status(500).json({ success: false });
  }
};

// ─── INGEST: SESSION ──────────────────────────────────────────────────────────

exports.ingestSession = async (req, res) => {
  try {
    const data = sanitize({
      visitorId:  req.body.visitorId  || '',
      sessionId:  req.body.sessionId  || '',
      startTime:  req.body.startTime  || Date.now(),
      endTime:    req.body.endTime    || Date.now(),
      duration:   Number(req.body.duration)   || 0,
      pageCount:  Number(req.body.pageCount)  || 1,
      bounced:    Boolean(req.body.bounced),
      device:     req.body.device     || 'desktop',
      browser:    req.body.browser    || '',
      os:         req.body.os         || '',
      referrer:   req.body.referrer   || '',
      utmSource:  req.body.utmSource  || '',
      utmMedium:  req.body.utmMedium  || '',
      utmCampaign:req.body.utmCampaign|| '',
      timestamp:  Date.now(),
    });
    const docId = req.body.sessionId ? sessionDocId(req.body.sessionId) : db.collection('analytics_sessions').doc().id;
    await db.collection('analytics_sessions').doc(docId).set(data, { merge: true });
    res.json({ success: true });
  } catch (e) {
    console.error('ingestSession', e);
    res.status(500).json({ success: false });
  }
};

// ─── INGEST: CONSENT ─────────────────────────────────────────────────────────

exports.ingestConsent = async (req, res) => {
  try {
    const data = {
      visitorId:   String(req.body.visitorId   || '').slice(0, 100),
      decision:    ['all', 'essential', 'custom'].includes(req.body.decision) ? req.body.decision : 'essential',
      analytics:   Boolean(req.body.analytics),
      marketing:   Boolean(req.body.marketing),
      preferences: Boolean(req.body.preferences),
      essential:   true,
      userAgent:   String(req.body.userAgent || '').slice(0, 300),
      timestamp:   Date.now(),
      expiresAt:   Date.now() + 365 * 24 * 60 * 60 * 1000,
    };
    console.log('[Analytics] Consent:', data.decision, '| visitor:', data.visitorId?.slice(0, 12));
    await db.collection('analytics_consents').add(data);
    res.json({ success: true });

  } catch (e) {
    console.error('ingestConsent', e);
    res.status(500).json({ success: false });
  }
};

// ─── INGEST: PERFORMANCE ──────────────────────────────────────────────────────

exports.ingestPerformance = async (req, res) => {
  try {
    const data = sanitize({
      url:       req.body.url       || '',
      visitorId: req.body.visitorId || '',
      sessionId: req.body.sessionId || '',
      lcp:       Number(req.body.lcp)   || 0,
      fcp:       Number(req.body.fcp)   || 0,
      ttfb:      Number(req.body.ttfb)  || 0,
      cls:       Number(req.body.cls)   || 0,
      inp:       Number(req.body.inp)   || 0,
      timestamp: Date.now(),
    });
    await db.collection('analytics_performance').add(data);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
};

// ─── ADMIN: OVERVIEW KPIs ────────────────────────────────────────────────────

exports.getOverview = async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const since = getStartOf(range);

    const [pvSnap, sessSnap] = await Promise.all([
      db.collection('analytics_pageviews').where('timestamp', '>=', since.getTime()).orderBy('timestamp', 'desc').limit(ANALYTICS_READ_CAP).get(),
      db.collection('analytics_sessions').where('timestamp', '>=', since.getTime()).orderBy('timestamp', 'desc').limit(ANALYTICS_READ_CAP).get(),
    ]);
    const capped = pvSnap.size >= ANALYTICS_READ_CAP || sessSnap.size >= ANALYTICS_READ_CAP;

    const sessions  = sessSnap.docs.map(d => d.data());
    const pageviews = pvSnap.docs.map(d => d.data());

    const uniqueVisitors  = new Set(sessions.map(s => s.visitorId)).size;
    const totalSessions   = sessions.length;
    const bouncedSessions = sessions.filter(s => s.bounced).length;
    const bounceRate      = totalSessions > 0 ? Math.round((bouncedSessions / totalSessions) * 100) : 0;
    const avgDuration     = totalSessions > 0
      ? Math.round(sessions.reduce((a, s) => a + (s.duration || 0), 0) / totalSessions)
      : 0;
    const avgPages = totalSessions > 0
      ? (sessions.reduce((a, s) => a + (s.pageCount || 1), 0) / totalSessions).toFixed(1)
      : 0;

    // Daily visitors breakdown for line chart
    const dailyMap = {};
    pageviews.forEach(pv => {
      const day = new Date(pv.timestamp).toISOString().slice(0, 10);
      dailyMap[day] = (dailyMap[day] || 0) + 1;
    });
    const dailyData = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, views]) => ({ date, views }));

    res.json({
      success: true,
      capped,
      data: {
        totalPageviews: pageviews.length,
        uniqueVisitors,
        totalSessions,
        bounceRate,
        avgDuration,
        avgPages: Number(avgPages),
        dailyData,
      }
    });
  } catch (e) {
    console.error('getOverview', e);
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

// ─── ADMIN: PAGE ANALYTICS ───────────────────────────────────────────────────

exports.getPageviews = async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const since = getStartOf(range);

    const snap = await db.collection('analytics_pageviews')
      .where('timestamp', '>=', since.getTime())
      .orderBy('timestamp', 'desc')
      .limit(2000)
      .get();

    const pageMap = {};
    snap.docs.forEach(d => {
      const { url, timeOnPage, scrollDepth, visitorId } = d.data();
      if (!url) return;
      const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
      if (!pageMap[path]) pageMap[path] = { url: path, views: 0, uniqueVisitors: new Set(), totalTime: 0, totalScroll: 0 };
      pageMap[path].views++;
      pageMap[path].uniqueVisitors.add(visitorId);
      pageMap[path].totalTime   += (timeOnPage  || 0);
      pageMap[path].totalScroll += (scrollDepth || 0);
    });

    const pages = Object.values(pageMap).map(p => ({
      url:         p.url,
      views:       p.views,
      uniqueViews: p.uniqueVisitors.size,
      avgTime:     p.views > 0 ? Math.round(p.totalTime / p.views) : 0,
      avgScroll:   p.views > 0 ? Math.round(p.totalScroll / p.views) : 0,
    })).sort((a, b) => b.views - a.views).slice(0, 20);

    res.json({ success: true, data: pages });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

// ─── ADMIN: EVENT ANALYTICS ──────────────────────────────────────────────────

exports.getEvents = async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const since = getStartOf(range);

    const snap = await db.collection('analytics_events')
      .where('timestamp', '>=', since.getTime())
      .orderBy('timestamp', 'desc')
      .limit(2000)
      .get();

    const eventMap = {};
    snap.docs.forEach(d => {
      const { name, url } = d.data();
      if (!name) return;
      if (!eventMap[name]) eventMap[name] = { name, count: 0, pages: new Set() };
      eventMap[name].count++;
      if (url) eventMap[name].pages.add((() => { try { return new URL(url).pathname; } catch { return url; } })());
    });

    const events = Object.values(eventMap)
      .map(e => ({ name: e.name, count: e.count, uniquePages: e.pages.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    res.json({ success: true, data: events });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

// ─── ADMIN: CONSENT STATS ────────────────────────────────────────────────────

exports.getConsentStats = async (req, res) => {
  try {
    const range = req.query.range || '30d';
    const since = getStartOf(range);

    const snap = await db.collection('analytics_consents')
      .where('timestamp', '>=', since.getTime())
      .orderBy('timestamp', 'desc')
      .limit(ANALYTICS_READ_CAP)
      .get();

    const consents = snap.docs.map(d => d.data());
    const total = consents.length;
    const acceptAll     = consents.filter(c => c.decision === 'all').length;
    const essentialOnly = consents.filter(c => c.decision === 'essential').length;
    const custom        = consents.filter(c => c.decision === 'custom').length;
    const analyticsOn   = consents.filter(c => c.analytics).length;
    const marketingOn   = consents.filter(c => c.marketing).length;
    const preferencesOn = consents.filter(c => c.preferences).length;

    // Daily consent trend
    const dailyMap = {};
    consents.forEach(c => {
      const day = new Date(c.timestamp).toISOString().slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { date: day, total: 0, accepted: 0 };
      dailyMap[day].total++;
      if (c.decision === 'all') dailyMap[day].accepted++;
    });
    const trend = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      data: {
        total,
        acceptAll,
        essentialOnly,
        custom,
        analyticsRate:    total > 0 ? Math.round((analyticsOn   / total) * 100) : 0,
        marketingRate:    total > 0 ? Math.round((marketingOn   / total) * 100) : 0,
        preferencesRate:  total > 0 ? Math.round((preferencesOn / total) * 100) : 0,
        acceptRate:       total > 0 ? Math.round((acceptAll     / total) * 100) : 0,
        trend,
        breakdown: [
          { name: 'Accept All',      value: acceptAll,     fill: '#920075' },
          { name: 'Essential Only',  value: essentialOnly, fill: '#D4AF37' },
          { name: 'Custom',          value: custom,        fill: '#6366f1' },
        ],
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

// ─── ADMIN: DEVICES ──────────────────────────────────────────────────────────

exports.getDevices = async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const since = getStartOf(range);

    const snap = await db.collection('analytics_sessions')
      .where('timestamp', '>=', since.getTime())
      .orderBy('timestamp', 'desc')
      .limit(ANALYTICS_READ_CAP)
      .get();

    const sessions = snap.docs.map(d => d.data());

    const deviceMap  = {};
    const browserMap = {};
    const osMap      = {};

    sessions.forEach(s => {
      const dev = s.device  || 'Unknown';
      const br  = s.browser || 'Unknown';
      const os  = s.os      || 'Unknown';
      deviceMap[dev]   = (deviceMap[dev]  || 0) + 1;
      browserMap[br]   = (browserMap[br]  || 0) + 1;
      osMap[os]        = (osMap[os]       || 0) + 1;
    });

    const toArr = (map, fill) =>
      Object.entries(map).map(([name, value]) => ({ name, value, fill }))
        .sort((a, b) => b.value - a.value).slice(0, 8);

    const COLORS = ['#920075','#D4AF37','#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6','#ec4899'];

    res.json({
      success: true,
      data: {
        devices:  toArr(deviceMap,  '#920075').map((d, i) => ({ ...d, fill: COLORS[i % COLORS.length] })),
        browsers: toArr(browserMap, '#D4AF37').map((d, i) => ({ ...d, fill: COLORS[i % COLORS.length] })),
        os:       toArr(osMap,      '#6366f1').map((d, i) => ({ ...d, fill: COLORS[i % COLORS.length] })),
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

// ─── ADMIN: TRAFFIC SOURCES ──────────────────────────────────────────────────

exports.getTrafficSources = async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const since = getStartOf(range);

    const snap = await db.collection('analytics_sessions')
      .where('timestamp', '>=', since.getTime())
      .orderBy('timestamp', 'desc')
      .limit(ANALYTICS_READ_CAP)
      .get();

    const sessions = snap.docs.map(d => d.data());

    const utmMap     = {};
    const sourceMap  = {};

    sessions.forEach(s => {
      // UTM campaign
      const camp = s.utmCampaign || 'none';
      utmMap[camp] = (utmMap[camp] || 0) + 1;

      // Referrer source classification
      let src = 'Direct';
      const ref = (s.referrer || '').toLowerCase();
      if (s.utmSource) src = s.utmSource;
      else if (ref.includes('google') || ref.includes('bing') || ref.includes('yahoo')) src = 'Organic Search';
      else if (ref.includes('facebook') || ref.includes('instagram') || ref.includes('twitter') || ref.includes('linkedin')) src = 'Social';
      else if (ref && !ref.includes(process.env.DOMAIN || 'alimenture')) src = 'Referral';
      sourceMap[src] = (sourceMap[src] || 0) + 1;
    });

    const COLORS = ['#920075','#D4AF37','#6366f1','#f59e0b','#10b981','#ef4444'];
    const toBar = (map) =>
      Object.entries(map).map(([name, sessions], i) => ({ name, sessions, fill: COLORS[i % COLORS.length] }))
        .sort((a, b) => b.sessions - a.sessions).slice(0, 8);

    res.json({
      success: true,
      data: {
        sources:   toBar(sourceMap),
        campaigns: toBar(utmMap).filter(c => c.name !== 'none'),
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

// ─── ADMIN: ACTIVE VISITORS ──────────────────────────────────────────────────

exports.getActiveVisitors = async (req, res) => {
  try {
    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    const snap = await db.collection('analytics_pageviews')
      .where('timestamp', '>=', fiveMinsAgo)
      .orderBy('timestamp', 'desc')
      .limit(ANALYTICS_READ_CAP)
      .get();
    const uniqueActive = new Set(snap.docs.map(d => d.data().visitorId)).size;
    res.json({ success: true, data: { active: uniqueActive } });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

// ─── ADMIN: PERFORMANCE ──────────────────────────────────────────────────────

exports.getPerformance = async (req, res) => {
  try {
    const range = req.query.range || '7d';
    const since = getStartOf(range);
    const snap  = await db.collection('analytics_performance').where('timestamp', '>=', since.getTime()).orderBy('timestamp', 'desc').limit(ANALYTICS_READ_CAP).get();
    const docs  = snap.docs.map(d => d.data());

    const avg = (arr, key) => arr.length
      ? Math.round(arr.reduce((a, d) => a + (d[key] || 0), 0) / arr.length)
      : 0;

    const pagePerf = {};
    docs.forEach(d => {
      const p = (() => { try { return new URL(d.url).pathname; } catch { return d.url; } })();
      if (!pagePerf[p]) pagePerf[p] = [];
      pagePerf[p].push(d);
    });

    const pages = Object.entries(pagePerf).map(([url, arr]) => ({
      url,
      lcp:  avg(arr, 'lcp'),
      fcp:  avg(arr, 'fcp'),
      ttfb: avg(arr, 'ttfb'),
      cls:  (arr.reduce((a, d) => a + (d.cls || 0), 0) / arr.length).toFixed(3),
      count: arr.length,
    })).sort((a, b) => b.lcp - a.lcp).slice(0, 15);

    res.json({
      success: true,
      data: {
        avgLcp:  avg(docs, 'lcp'),
        avgFcp:  avg(docs, 'fcp'),
        avgTtfb: avg(docs, 'ttfb'),
        avgCls:  docs.length ? (docs.reduce((a, d) => a + (d.cls || 0), 0) / docs.length).toFixed(3) : 0,
        pages,
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

// ─── ADMIN: SALES ANALYTICS ──────────────────────────────────────────────────

exports.getSalesOverview = async (req, res) => {
  try {
    const [stats, userSnap, productSnap] = await Promise.all([
      sumShards('analytics_sales_global', 'overview'),
      db.collection('users').where('role', 'in', ['customer', 'user']).count().get(),
      db.collection('products').count().get(),
    ]);

    res.json({
      success: true,
      data: {
        totalRevenue: stats.revenue || 0,
        totalOrders: stats.orderCount || 0,
        activeProducts: productSnap.data().count,
        totalCustomers: userSnap.data().count,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load sales overview' });
  }
};

exports.getSalesTrend = async (req, res) => {
  try {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      months.push({ d, key: d.toISOString().split('T')[0].slice(0, 7) });
    }

    const rollups = await Promise.all(months.map((m) => sumShards('analytics_sales_monthly', m.key)));
    const trendData = months.map((m, idx) => ({
      month: monthNames[m.d.getMonth()],
      year: m.d.getFullYear(),
      sales: rollups[idx].revenue || 0,
      orders: rollups[idx].orderCount || 0,
    }));

    res.json({ success: true, data: trendData });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load sales trend' });
  }
};

exports.getTopProducts = async (req, res) => {
  try {
    const snap = await db.collection('analytics_products_lifetime')
      .orderBy('unitsSold', 'desc')
      .limit(5)
      .get();
      
    const products = snap.docs.map(doc => {
       const data = doc.data();
       return {
           name: data.name || doc.id,
           sold: data.unitsSold || 0,
           revenue: `₹${(data.revenue || 0).toLocaleString()}`,
           progress: Math.min(100, ((data.unitsSold || 0) / 50) * 100) // Dummy target of 50 for progress bar
       };
    });
    
    res.json({ success: true, data: products });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};

exports.getCategoryDistribution = async (req, res) => {
  try {
    const snap = await db.collection('analytics_products_lifetime').limit(1000).get();
    
    const catCounts = {};
    snap.docs.forEach(doc => {
       const cat = doc.data().category || 'General';
       catCounts[cat] = (catCounts[cat] || 0) + (doc.data().unitsSold || 0); // Aggregate by units sold
    });
    
    const colors = ['#E83D6E', '#1A1A1A', '#4F46E5', '#F59E0B', '#10B981', '#6366F1'];
    const dist = Object.keys(catCounts).map((cat, i) => ({
      name: cat,
      value: catCounts[cat],
      color: colors[i % colors.length]
    })).filter(c => c.value > 0).sort((a,b) => b.value - a.value).slice(0, 6);
    
    res.json({ success: true, data: dist.length > 0 ? dist : [{ name: 'No Products', value: 1, color: '#F3F4F6' }] });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to load analytics' });
  }
};
