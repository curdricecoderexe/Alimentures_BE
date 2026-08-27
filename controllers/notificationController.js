const admin = require('firebase-admin');
const db = require('../config/firebase');
const log = require('../lib/logger');

exports.getNotifications = async (req, res) => {
  try {
    const { role, uid } = req.user;

    const snapshot = await db.collection("notifications")
      .where("target", "in", [uid, role])
      .limit(50)
      .get();

    const notifications = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    notifications.sort((a, b) => {
      const ta = a.createdAt?.toMillis ? a.createdAt.toMillis() : (a.createdAt?._seconds ? a.createdAt._seconds * 1000 : 0);
      const tb = b.createdAt?.toMillis ? b.createdAt.toMillis() : (b.createdAt?._seconds ? b.createdAt._seconds * 1000 : 0);
      return tb - ta;
    });

    return res.status(200).json({ success: true, data: notifications });
  } catch (error) {
    log.error("notification.list_failed", { requestId: req.id, err: error });
    return res.status(500).json({ success: false, error: "Failed to fetch notifications" });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    const ref = db.collection("notifications").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Notification not found" });

    const target = doc.data().target;
    // The notification must be addressed to this user or to their role.
    if (target !== req.user.uid && target !== req.user.role) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    await ref.update({ read: true });
    return res.status(200).json({ success: true, message: "Marked as read" });
  } catch (error) {
    log.error("notification.mark_read_failed", { requestId: req.id, err: error });
    return res.status(500).json({ success: false, error: "Failed to update notification" });
  }
};

exports.createNotification = async (target, title, message) => {
  try {
    await db.collection("notifications").add({
      target,
      title,
      message,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    log.error("notification.create_failed", { target, err });
  }
};
