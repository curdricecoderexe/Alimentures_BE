/**
 * deliveryConstants.js — pincode delivery config defaults, limits and enums.
 *
 * NO business pricing is hard-coded in controllers or React components — the
 * numbers below are only the *fallback* defaults used when the admin has not
 * saved a `deliverySettings/global` document yet. They are chosen to reproduce
 * the pre-existing behaviour (`subtotal > 500 ? free : ₹50`) so nothing changes
 * on day one.
 */
'use strict';

const PINCODE_RE = /^[1-9][0-9]{5}$/; // Indian PIN: 6 digits, no leading zero

const DELIVERY_METHODS = Object.freeze(['standard', 'fastest']);

// Who delivers a PIN: Shiprocket couriers, or your own dedicated local partner.
// 'local' orders are never pushed to Shiprocket; staff update their status.
const DELIVERY_PARTNERS = Object.freeze(['shiprocket', 'local']);

// Per-PIN standard fee mode: follow the global default, or a custom amount.
const STANDARD_FEE_TYPES = Object.freeze(['default', 'custom']);

const COURIER_FEE_MODES = Object.freeze(['bands', 'actual']);

const FEE_MIN = 0;
const FEE_MAX = 5000; // hard ceiling — protects against fat-finger / manipulation

const DEFAULT_SETTINGS = Object.freeze({
  // standard
  defaultDeliveryFee: 50,
  defaultStandardEta: '3–5 business days',
  // free delivery
  freeDeliveryEnabled: true,
  freeDeliveryThreshold: 500,
  // fastest
  fastestDeliveryEnabled: false,
  defaultFastestDeliveryFee: 120,
  defaultFastestEta: '1–2 business days',
  fastestCutoffTime: '', // e.g. "2:00 PM" — display only
  fastestMinOrderValue: 0,
  fastestMaxOrderValue: 0, // 0 = no maximum
  // servicing model: when a PIN has no rule, is it deliverable by default?
  serviceByDefault: true,
  // courier-linked fees: when ON, the default standard fee comes from the band
  // matching Shiprocket's freight quote for the cart (custom PIN fees still win).
  courierLinkedFee: false,
  // How a courier-linked fee is worked out:
  //   'bands'  → the band matching the freight quote (courierFeeBands below)
  //   'actual' → the CHEAPEST courier's real freight for this cart + markup %
  //              (fastest uses the cheapest express courier). That courier is
  //              saved on the order and assigned by default at dispatch.
  courierFeeMode: 'bands',
  courierFeeMarkupPct: 0, // 'actual' mode: buffer for weight re-checks / COD / GST
  courierFeeBands: [
    { maxRate: 50, fee: 40 },
    { maxRate: 80, fee: 60 },
    { maxRate: 120, fee: 90 },
    { maxRate: 0, fee: 140 }, // 0 = everything above the previous band
  ],
});

const SETTINGS_DOC = 'global';
const SETTINGS_COLLECTION = 'deliverySettings';
const PINCODE_COLLECTION = 'deliveryPincodes';

const CSV_HEADERS = [
  'pincode', 'city', 'state', 'deliveryAvailable', 'deliveryFee',
  'fastestDeliveryAvailable', 'fastestDeliveryFee', 'standardEta', 'fastestEta', 'note',
  'deliveryPartner',
];

const BULK_MAX_ROWS = 5000; // per import / bulk request

module.exports = {
  PINCODE_RE,
  DELIVERY_METHODS,
  DELIVERY_PARTNERS,
  STANDARD_FEE_TYPES,
  COURIER_FEE_MODES,
  FEE_MIN,
  FEE_MAX,
  DEFAULT_SETTINGS,
  SETTINGS_DOC,
  SETTINGS_COLLECTION,
  PINCODE_COLLECTION,
  CSV_HEADERS,
  BULK_MAX_ROWS,
};
