const db = require("../config/firebase");
const log = require("../lib/logger");
const { createAuditLog } = require("../services/auditService");

exports.getSettings = async (req, res) => {
  try {
    const doc = await db.collection("settings").doc("storefront").get();
    if (!doc.exists) {
      return res.status(200).json({ success: true, data: { newArrivalPoster: null } });
    }
    return res.status(200).json({ success: true, data: doc.data() });
  } catch (error) {
    log.error("settings.get_failed", { requestId: req.id, err: error });
    return res.status(500).json({ success: false, error: "Failed to fetch settings" });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const { newArrivalPoster } = req.body; // validated by imageField middleware

    await db.collection("settings").doc("storefront").set({
      newArrivalPoster: newArrivalPoster || null,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_STOREFRONT_SETTINGS',
      resourceId: 'storefront',
      previousState: null,
      newState: { newArrivalPoster: newArrivalPoster ? '[set]' : null },
      ipAddress: req.ip,
    });

    return res.status(200).json({ success: true, message: "Settings updated successfully" });
  } catch (error) {
    log.error("settings.update_failed", { requestId: req.id, err: error });
    return res.status(500).json({ success: false, error: "Failed to update settings" });
  }
};

/**
 * Footer social links — managed from Admin → Social Links.
 * Stored on settings/storefront as `socialLinks: [{ platform, url, enabled }]`
 * (array order = display order). Only http(s) URLs are accepted.
 */
const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'youtube', 'linkedin', 'x', 'whatsapp', 'pinterest', 'threads', 'telegram'];
const MAX_SOCIAL_LINKS = 12;

exports.SOCIAL_PLATFORMS = SOCIAL_PLATFORMS;

/**
 * About page → "Our commitment" band copy — Admin → About Page.
 * Stored on settings/storefront as `commitment` { eyebrow, headline, highlight,
 * pledges: [string ×1–3], ctaLabel, ctaLink }. Body is pre-validated by the route.
 */
exports.updateCommitment = async (req, res) => {
  try {
    const b = req.body;
    const pledges = (b.pledges || []).map((p) => String(p).trim()).filter(Boolean);
    if (pledges.length < 1 || pledges.length > 3) {
      return res.status(400).json({ success: false, error: "Add between one and three commitments" });
    }
    if (pledges.some((p) => p.length > 60)) {
      return res.status(400).json({ success: false, error: "Each commitment must be 60 characters or fewer" });
    }
    const commitment = {
      eyebrow: b.eyebrow || 'Our commitment',
      headline: b.headline,
      highlight: b.highlight || '',
      pledges,
      ctaLabel: b.ctaLabel || 'Shop',
      ctaLink: b.ctaLink || '/shop',
    };

    await db.collection("settings").doc("storefront").set({
      commitment,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_COMMITMENT_COPY',
      resourceId: 'storefront',
      previousState: null,
      newState: { commitment },
      ipAddress: req.ip,
    });

    return res.status(200).json({ success: true, data: { commitment } });
  } catch (error) {
    log.error("settings.commitment_update_failed", { requestId: req.id, err: error });
    return res.status(500).json({ success: false, error: "Failed to save the commitment section" });
  }
};

/**
 * Gift Hampers page visibility — Admin → Gift Hampers.
 * Stored on settings/storefront as `hampersVisible` (missing = visible). When
 * false the storefront hides the page and every link to it.
 */
exports.updateHampersVisibility = async (req, res) => {
  try {
    const visible = req.body?.visible;
    if (typeof visible !== 'boolean') {
      return res.status(400).json({ success: false, error: "visible must be true or false" });
    }

    await db.collection("settings").doc("storefront").set({
      hampersVisible: visible,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_HAMPERS_VISIBILITY',
      resourceId: 'storefront',
      previousState: null,
      newState: { hampersVisible: visible },
      ipAddress: req.ip,
    });

    return res.status(200).json({ success: true, data: { hampersVisible: visible } });
  } catch (error) {
    log.error("settings.hampers_update_failed", { requestId: req.id, err: error });
    return res.status(500).json({ success: false, error: "Failed to update the Gift Hampers page" });
  }
};

exports.updateSocialLinks = async (req, res) => {
  try {
    const raw = req.body?.socialLinks;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ success: false, error: "socialLinks must be an array" });
    }
    if (raw.length > MAX_SOCIAL_LINKS) {
      return res.status(400).json({ success: false, error: `At most ${MAX_SOCIAL_LINKS} social links are allowed` });
    }

    const socialLinks = [];
    for (const [i, item] of raw.entries()) {
      const platform = String(item?.platform || '').toLowerCase();
      if (!SOCIAL_PLATFORMS.includes(platform)) {
        return res.status(400).json({ success: false, error: `Row ${i + 1}: unknown platform` });
      }
      const url = String(item?.url || '').trim();
      let parsed;
      try { parsed = new URL(url); } catch { parsed = null; }
      if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || url.length > 500) {
        return res.status(400).json({ success: false, error: `Row ${i + 1}: enter a full link starting with https://` });
      }
      socialLinks.push({ platform, url: parsed.toString(), enabled: item?.enabled !== false });
    }

    await db.collection("settings").doc("storefront").set({
      socialLinks,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    createAuditLog({
      adminId: req.user?.uid,
      adminEmail: req.user?.email || 'unknown',
      action: 'UPDATE_SOCIAL_LINKS',
      resourceId: 'storefront',
      previousState: null,
      newState: { socialLinks },
      ipAddress: req.ip,
    });

    return res.status(200).json({ success: true, data: { socialLinks }, message: "Social links updated" });
  } catch (error) {
    log.error("settings.social_update_failed", { requestId: req.id, err: error });
    return res.status(500).json({ success: false, error: "Failed to update social links" });
  }
};
