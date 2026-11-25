/**
 * hamperEnquiryController.js — bulk / corporate gift-hamper enquiries from the
 * Gift Hampers page. Stored in `hamperEnquiries` and listed in
 * Admin → Gift Hampers; the team is emailed (ORDER_ALERT_EMAILS) when set.
 */
'use strict';

const db = require('../config/firebase');
const log = require('../lib/logger');
const { sendMail } = require('../utils/mailer');

const COLLECTION = 'hamperEnquiries';
const STATUSES = ['new', 'contacted', 'quoted', 'won', 'closed'];

function normaliseMobile(raw) {
  let d = String(raw || '').replace(/[\s\-()]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

const alertEmails = () => String(process.env.ORDER_ALERT_EMAILS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

exports.STATUSES = STATUSES;

// POST /api/hampers/enquiries — public
exports.createEnquiry = async (req, res) => {
  try {
    const b = req.body;
    const name = String(b.name || '').replace(/\s+/g, ' ').trim();
    if (name.length < 2) return res.status(400).json({ success: false, error: 'Please enter your name' });
    const mobile = normaliseMobile(b.mobile);
    if (!mobile) return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit mobile number' });
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address' });
    }

    const enquiry = {
      name,
      mobile,
      email: b.email || '',
      company: b.company || '',
      hamper: b.hamper || '',
      quantity: b.quantity,
      occasion: b.occasion || '',
      deliveryDate: b.deliveryDate || '',
      city: b.city || '',
      branding: Boolean(b.branding),
      budget: b.budget || '',
      notes: b.notes || '',
      status: 'new',
      createdAt: new Date().toISOString(),
    };
    const ref = await db.collection(COLLECTION).add(enquiry);

    const to = alertEmails();
    if (to.length) {
      const lines = [
        `New gift-hamper enquiry (${enquiry.quantity} boxes)`,
        '',
        `Name: ${name}`, `Mobile: ${mobile}`, enquiry.email && `Email: ${enquiry.email}`,
        enquiry.company && `Company: ${enquiry.company}`, enquiry.hamper && `Hamper: ${enquiry.hamper}`,
        enquiry.occasion && `Occasion: ${enquiry.occasion}`, enquiry.deliveryDate && `Needed by: ${enquiry.deliveryDate}`,
        enquiry.city && `Deliver to: ${enquiry.city}`, enquiry.budget && `Budget per box: ${enquiry.budget}`,
        `Branding: ${enquiry.branding ? 'Yes' : 'No'}`, enquiry.notes && `Notes: ${enquiry.notes}`,
      ].filter(Boolean);
      // Plain text only — every field is visitor-supplied.
      sendMail(to.join(','), `Hamper enquiry — ${name} (${enquiry.quantity})`, lines.join('\n'))
        .catch((err) => log.warn('hampers.enquiry_mail_failed', { err }));
    }

    return res.status(201).json({ success: true, data: { id: ref.id } });
  } catch (err) {
    log.error('hampers.enquiry_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
  }
};

// GET /api/hampers/enquiries — admin
exports.listEnquiries = async (req, res) => {
  try {
    // Newest 200 — older enquiries stay in Firestore but aren't listed.
    const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(200).get();
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({ success: true, data });
  } catch (err) {
    log.error('hampers.enquiry_list_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to load enquiries' });
  }
};

// PATCH /api/hampers/enquiries/:id — admin (status)
exports.updateEnquiry = async (req, res) => {
  try {
    const ref = db.collection(COLLECTION).doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ success: false, error: 'Enquiry not found' });
    await ref.update({ status: req.body.status, updatedAt: new Date().toISOString() });
    return res.status(200).json({ success: true });
  } catch (err) {
    log.error('hampers.enquiry_update_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Update failed' });
  }
};

// DELETE /api/hampers/enquiries/:id — admin
exports.deleteEnquiry = async (req, res) => {
  try {
    const ref = db.collection(COLLECTION).doc(req.params.id);
    if (!(await ref.get()).exists) return res.status(404).json({ success: false, error: 'Enquiry not found' });
    await ref.delete();
    return res.status(200).json({ success: true });
  } catch (err) {
    log.error('hampers.enquiry_delete_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Delete failed' });
  }
};
