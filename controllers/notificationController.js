/**
 * Team notifications — by email.
 *
 * The admin/staff bell used to poll a `notifications` collection, which cost
 * thousands of Firestore reads per open tab per hour. Store updates are now
 * emailed to the team inboxes in ORDER_ALERT_EMAILS instead (no Firestore reads
 * or writes). Customers are informed by the order emails sent from
 * orderController.sendOrderEmail.
 *
 * Existing documents in `notifications` are left untouched.
 */
const log = require('../lib/logger');
const { sendMail } = require('../utils/mailer');
const { buildTeamUpdateEmail } = require('../utils/emailTemplates');

const teamInboxes = () => String(process.env.ORDER_ALERT_EMAILS || '')
  .split(',').map((e) => e.trim()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

// The same update is often raised for admin and staff at once — send it once.
const recent = new Map(); // key -> sentAt
const DEDUPE_MS = 60 * 1000;

/**
 * Email the shop team about a store update. Fire-and-forget; never throws.
 * @param {string} title
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.orderId]  adds an "Open order" button
 */
async function notifyTeam(title, message, { orderId } = {}) {
  try {
    const to = teamInboxes();
    if (!to.length) {
      log.warn('notification.no_team_inbox', { title });
      return;
    }
    const key = `${title}|${message}`;
    const now = Date.now();
    for (const [k, at] of recent) if (now - at > DEDUPE_MS) recent.delete(k);
    if (recent.has(key)) return;
    recent.set(key, now);

    const { subject, text, html } = buildTeamUpdateEmail({ title, message, orderId });
    await sendMail(to.join(','), subject, text, html);
  } catch (err) {
    log.error('notification.email_failed', { title, err });
  }
}

/**
 * Kept for existing callers: `target` 'admin' / 'staff' emails the team;
 * a customer uid is a no-op (customers get order emails instead).
 */
exports.createNotification = async (target, title, message, opts = {}) => {
  if (target === 'admin' || target === 'staff') return notifyTeam(title, message, opts);
  return undefined;
};

exports.notifyTeam = notifyTeam;
exports._internal = { teamInboxes, recent };
