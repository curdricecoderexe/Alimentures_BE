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
