/**
 * deliveryConstants.js — pincode delivery config defaults, limits and enums.
 *
 * NO business pricing is hard-coded in controllers or React components — the
 * numbers below are the defaults used when the admin has not saved a value in
 * `deliverySettings/global`. Courier-linked 'bands' pricing and "no free
 * delivery" are enforced policy (see deliveryService.normaliseSettings).
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

const MAX_FEE_BANDS = 20;

const DEFAULT_SETTINGS = Object.freeze({
  // standard — POLICY: the customer always pays the courier cost, via the
  // courier-fee bands below. defaultDeliveryFee is only a fallback:
  //   • Shiprocket PINs when no freight quote is available (Shiprocket down):
  //     charged PER 0.5 kg billing slab of the parcel, so heavy carts still pay
  //   • local-partner PINs set to "Default fee": charged once (flat)
  defaultDeliveryFee: 70,
  defaultStandardEta: '3–5 business days',
  // free delivery — switched OFF by policy (normaliseSettings forces false)
  freeDeliveryEnabled: false,
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
  // Courier-linked fees — ALWAYS ON in 'bands' mode (normaliseSettings forces it).
  // Shiprocket's freight quote for the cart (cheapest courier, real parcel
  // weight) is matched to a band and the customer pays that band's fee. The fee
  // is never below the quote itself, so delivery is always fully collected.
  // That courier is saved on the order and assigned by default at dispatch.
  courierLinkedFee: true,
  courierFeeMode: 'bands',
  courierFeeMarkupPct: 0, // unused in 'bands' mode
  // Each band's fee = its upper limit, so the customer covers the freight in full.
  // Tuned to live quotes from 600113 (e.g. 0.5 kg ≈ ₹82 → ₹100; 1 kg ≈ ₹133 → ₹140).
  courierFeeBands: [
    { maxRate: 60, fee: 60 },
    { maxRate: 80, fee: 80 },
    { maxRate: 100, fee: 100 },
    { maxRate: 120, fee: 120 },
    { maxRate: 140, fee: 140 },
    { maxRate: 170, fee: 170 },
    { maxRate: 200, fee: 200 },
    { maxRate: 250, fee: 250 },
    { maxRate: 300, fee: 300 },
    { maxRate: 400, fee: 400 },
    { maxRate: 500, fee: 500 },
    { maxRate: 650, fee: 650 },
    { maxRate: 800, fee: 800 },
    { maxRate: 1000, fee: 1000 },
    { maxRate: 1300, fee: 1300 },
    { maxRate: 1600, fee: 1600 },
    { maxRate: 2000, fee: 2000 },
    { maxRate: 0, fee: 2500 }, // 0 = everything above; never less than the quote itself
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
  MAX_FEE_BANDS,
  DEFAULT_SETTINGS,
  SETTINGS_DOC,
  SETTINGS_COLLECTION,
  PINCODE_COLLECTION,
  CSV_HEADERS,
  BULK_MAX_ROWS,
};
