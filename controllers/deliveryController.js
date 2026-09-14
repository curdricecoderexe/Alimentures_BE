/**
 * deliveryController.js — customer-facing delivery + location endpoints.
 * All read-only. Rate-limited in the route file.
 */
'use strict';

const log = require('../lib/logger');
const locationService = require('../services/locationService');
const {
  resolveDeliveryOptions, isValidPincode, normalisePincode, getPincodeRule,
} = require('../services/deliveryService');

/** GET /api/delivery/locations/states */
exports.getStates = (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  return res.status(200).json({ success: true, data: locationService.listStates() });
};

/** GET /api/delivery/locations/cities?state=Tamil%20Nadu&q=chen&limit=50 */
exports.getCities = (req, res) => {
  const { state, q, limit } = req.query;
  if (!state || !locationService.isValidState(state)) {
    return res.status(400).json({ success: false, error: 'A valid Indian state is required' });
  }
  const cities = locationService.listCities(state, { q, limit });
  res.set('Cache-Control', 'public, max-age=3600');
  return res.status(200).json({ success: true, data: cities });
};

/** GET /api/delivery/pincode/:pincode — lightweight availability check. */
exports.getPincodeInfo = async (req, res) => {
  try {
    const pincode = normalisePincode(req.params.pincode);
    if (!isValidPincode(pincode)) {
      return res.status(400).json({ success: false, error: 'PIN code must be 6 digits' });
    }
    const rule = await getPincodeRule(pincode);
    const opts = await resolveDeliveryOptions({ pincode, subtotal: 0 });
    return res.status(200).json({
      success: true,
      data: {
        pincode,
        deliveryAvailable: opts.deliveryAvailable,
        city: rule?.city || null,
        state: rule?.state || null,
        reason: opts.reason,
      },
    });
  } catch (err) {
    log.error('delivery.pincode_info_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to check PIN code' });
  }
};

/**
 * GET /api/delivery/options/:pincode?subtotal=1234
 * Full delivery-option payload for the checkout screen. This is an ESTIMATE —
 * the authoritative fee is recomputed at order creation.
 */
exports.getDeliveryOptions = async (req, res) => {
  try {
    const pincode = normalisePincode(req.params.pincode);
    if (!isValidPincode(pincode)) {
      return res.status(400).json({ success: false, error: 'PIN code must be 6 digits' });
    }
    const subtotal = Math.max(0, Number(req.query.subtotal) || 0);
    const opts = await resolveDeliveryOptions({ pincode, subtotal });
    return res.status(200).json({ success: true, data: opts });
  } catch (err) {
    log.error('delivery.options_failed', { requestId: req.id, err });
    return res.status(500).json({ success: false, error: 'Failed to load delivery options' });
  }
};
