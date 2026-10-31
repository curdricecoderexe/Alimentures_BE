'use strict';

/**
 * Newsletter ("Clean Food Nourishment Circle") subscriptions.
 *
 * Public: POST /api/newsletter saves the email to `newsletterSubscribers`
 * (doc id = sha256(email), so re-submits are idempotent) and sends the branded
 * welcome email on first join or re-join. Every welcome carries a signed
 * one-click unsubscribe link. Admin: list + delete.
 */

const crypto = require('crypto');
const db = require('../config/firebase');
const admin = require('../lib/firebaseAdmin');
const log = require('../lib/logger');
const { sendMail } = require('../utils/mailer');
const { buildWelcomeEmail, emailShell, SITE_URL } = require('../utils/emailTemplates');
const { getCachedProducts } = require('./productController');
const { buildSlugMap } = require('../lib/slug');
const { createAuditLog } = require('../services/auditService');

const COLLECTION = 'newsletterSubscribers';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Signing key for unsubscribe links: explicit env var, else derived from the
// service-account key (stable across restarts, never exposed).
const SIGNING_KEY = (() => {
  if (process.env.NEWSLETTER_TOKEN_SECRET) return process.env.NEWSLETTER_TOKEN_SECRET;
  let material = 'alimenture-newsletter';
  try { material += JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}').private_key || ''; } catch { /* ignore */ }
  return crypto.createHash('sha256').update(material).digest('hex');
})();

const docId = (email) => crypto.createHash('sha256').update(email).digest('hex');
const sign = (id) => crypto.createHmac('sha256', SIGNING_KEY).update(id).digest('base64url');
const API_ORIGIN = (process.env.API_PUBLIC_URL || '').replace(/\/+$/, '');

/** Absolute unsubscribe link (falls back to the request's own origin). */
function unsubscribeUrl(req, id) {
  const origin = API_ORIGIN || `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/newsletter/unsubscribe?id=${id}&sig=${sign(id)}`;
}

/** Up to 4 real products for the welcome email (featured first). */
async function welcomePicks() {
  try {
    const all = (await getCachedProducts()).filter((p) => p.isDraft !== true && p.isPrivate !== true);
    const slugs = buildSlugMap(all);
    const featured = all.filter((p) => p.isFeatured);
    return (featured.length ? featured : all).slice(0, 4).map((p) => {
      const prices = (p.variants || []).map((v) => Number(v.price)).filter((n) => n > 0);
      const name = String(p.title || p.name || '');
      return {
        name: name === name.toUpperCase() ? name.toLowerCase().replace(/(^|[\s(\-–—/])([a-z])/g, (m, a, c) => a + c.toUpperCase()) : name,
        tagline: p.description || '',
        price: prices.length ? Math.min(...prices) : Number(p.price) || 0,
        from: prices.length > 1,
        image: p.image,
        url: `${SITE_URL}/products/${slugs.get(p.id) || p.id}`,
      };
    });
  } catch (err) {
    log.warn('newsletter.picks_failed', { err });
    return [];
  }
}

async function sendWelcome(req, ref, email) {
  const { subject, text, html, attachments } = buildWelcomeEmail({
    products: await welcomePicks(),
    unsubscribeUrl: unsubscribeUrl(req, ref.id),
  });
  const result = await sendMail(email, subject, text, html, attachments, {
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl(req, ref.id)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  if (result.success) await ref.set({ welcomeSentAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  else log.error('newsletter.welcome_failed', { requestId: req.id, err: result.error });
}

// ─── Public ──────────────────────────────────────────────────────────────────

exports.subscribe = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }
    const ref = db.collection(COLLECTION).doc(docId(email));
    const snap = await ref.get();
    const wasActive = snap.exists && snap.data().status === 'subscribed';

    if (!wasActive) {
      await ref.set({
        email,
        status: 'subscribed',
        source: String(req.body.source || 'footer').slice(0, 40),
        subscribedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...(snap.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
        unsubscribedAt: admin.firestore.FieldValue.delete(),
      }, { merge: true });
      // Don't make the visitor wait on SMTP.
      sendWelcome(req, ref, email).catch((err) => log.error('newsletter.welcome_failed', { err }));
    }

    // Same answer either way — the form must not reveal who is subscribed.
    return res.json({ success: true, message: "You're in! Check your inbox for a welcome email." });
  } catch (err) {
    log.error('newsletter.subscribe_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

/** GET shows a confirmation page; POST is RFC 8058 one-click (mail clients). */
exports.unsubscribe = async (req, res) => {
  const id = String(req.query.id || '');
  const sig = String(req.query.sig || '');
  const expected = sign(id);
  const valid = /^[a-f0-9]{64}$/.test(id) && sig.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));

  let ok = false;
  if (valid) {
    try {
      const ref = db.collection(COLLECTION).doc(id);
      if ((await ref.get()).exists) {
        await ref.set({ status: 'unsubscribed', unsubscribedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      ok = true;
    } catch (err) {
      log.error('newsletter.unsubscribe_failed', { requestId: req.id, err });
    }
  }
  if (req.method === 'POST') return res.status(ok ? 200 : 400).json({ success: ok });

  // The page reuses the email layout: allow its logo, Google Fonts and inline styles.
  res.set('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.status(ok ? 200 : 400).type('html').send(emailShell({
    icon: ok ? '👋' : '⚠️',
    eyebrow: 'Nourishment Circle',
    heading: ok ? "You've been unsubscribed" : 'This link is not valid',
    blurb: ok
      ? "You won't receive newsletter emails from us any more. Order updates and sign-in codes are not affected."
      : 'The unsubscribe link is incomplete or has been changed. Please use the link from your most recent email.',
    cta: { href: SITE_URL, label: 'Back to Alimenture' },
  }));
};

// ─── Admin ───────────────────────────────────────────────────────────────────

const iso = (t) => (t?.toDate ? t.toDate().toISOString() : null);

exports.listSubscribers = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 2000, 5000);
    const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
    res.set('Cache-Control', 'private, no-store');
    res.json({
      success: true,
      data: snap.docs.map((d) => {
        const v = d.data();
        return {
          id: d.id,
          email: v.email,
          status: v.status || 'subscribed',
          source: v.source || 'footer',
          createdAt: iso(v.createdAt),
          subscribedAt: iso(v.subscribedAt),
          unsubscribedAt: iso(v.unsubscribedAt),
          welcomeSent: !!v.welcomeSentAt,
        };
      }),
    });
  } catch (err) {
    log.error('newsletter.list_failed', { requestId: req.id, err });
    res.status(500).json({ success: false, error: 'Failed to load subscribers' });
  }
};

exports.deleteSubscriber = async (req, res) => {
  try {
    await db.collection(COLLECTION).doc(req.params.id).delete();
    createAuditLog({
      adminId: req.user?.uid, adminEmail: req.user?.email || 'unknown',
      action: 'DELETE_NEWSLETTER_SUBSCRIBER', resourceId: req.params.id, previousState: null, newState: null, ipAddress: req.ip,
    });
    res.json({ success: true, message: 'Subscriber removed' });
  } catch (err) {
    log.error('newsletter.delete_failed', { requestId: req.id, err });
    res.status(500).json({ success: false, error: 'Failed to remove subscriber' });
  }
};
