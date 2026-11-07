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
