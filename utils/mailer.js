const nodemailer = require('nodemailer');
const log = require('../lib/logger');

let transporter;
let transporterReady = false;

async function createTransporter() {
  if (transporter) return;

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    transporterReady = true;
    return;
  }

  // No SMTP configured.
  if (process.env.NODE_ENV === 'production') {
    log.error('email.no_smtp_config', { note: 'SMTP_HOST/USER/PASS missing — transactional email is DISABLED' });
    transporterReady = false;
    return;
  }

  // Dev only: Ethereal test inbox.
  const testAccount = await nodemailer.createTestAccount();
  transporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: { user: testAccount.user, pass: testAccount.pass },
  });
  transporterReady = true;
  log.warn('email.using_ethereal', { user: testAccount.user });
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} text            plain-text fallback
 * @param {string} [html]          rich HTML body
 * @param {Array}  [attachments]   nodemailer attachment objects
 *                                 (e.g. inline product images via `cid`, or a PDF invoice)
 */
const sendMail = async (to, subject, text, html, attachments) => {
  try {
    await createTransporter();
    if (!transporterReady) return { success: false, error: 'email_not_configured' };

    const info = await transporter.sendMail({
      from: `"Alimenture" <${process.env.SMTP_USER || 'updates@ethereal.email'}>`,
      to,
      subject,
      text,
      html: html || `<p>${text}</p>`,
      ...(attachments && attachments.length ? { attachments } : {}),
    });
    if (process.env.NODE_ENV !== 'production') {
      log.info('email.sent', { to, subject, preview: nodemailer.getTestMessageUrl(info) || undefined });
    }
    return { success: true };
  } catch (error) {
    log.error('email.send_failed', { to, subject, err: error });
    return { success: false, error: error.message };
  }
};

module.exports = { sendMail };
