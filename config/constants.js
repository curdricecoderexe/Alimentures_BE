/**
 * constants.js — single source of truth for enums, state machines, and limits.
 *
 * All order-status and role strings are lowercase everywhere in the codebase.
 * Normalisation happens at the boundary (utils/firebaseAuth.js for roles,
 * controllers for status writes).
 */

'use strict';

const ROLES = Object.freeze({
  ADMIN: 'admin',
  STAFF: 'staff',
  CUSTOMER: 'customer',
});

const PRIVILEGED_ROLES = Object.freeze(['admin', 'staff']);

const ORDER_STATES = Object.freeze({
  PAYMENT_PENDING: 'payment_pending',
  PAYMENT_SUCCESSFUL_NO_STOCK: 'payment_successful_no_stock',
  PENDING: 'pending',
  PROCESSING: 'processing',
  PACKED: 'packed',
  SHIPPED: 'shipped',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
});

/**
 * Fulfilment-only transitions for `PUT /orders/:id/status` (staff/delivery).
 * `refunded` is NOT reachable here — it goes through the dedicated admin
 * refund route: POST /orders/:id/refund. There is no order-cancellation
 * route; `cancelled` is only ever set by the reservation-release path for an
 * order that never got past payment (see releaseReservation / abandonPayment
 * in orderController.js).
 */
const ORDER_TRANSITIONS = Object.freeze({
  payment_successful_no_stock: ['pending', 'processing'],
  pending: ['processing', 'packed'],
  processing: ['packed', 'shipped'],
  packed: ['shipped', 'out_for_delivery'],
  shipped: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered', 'shipped'],
  delivered: [],
  payment_pending: [],
  cancelled: [],
  refunded: [],
});

/** States an order can be refunded from. */
const REFUNDABLE_STATES = Object.freeze(['delivered', 'out_for_delivery', 'shipped']);

const LIMITS = Object.freeze({
  // Body parsing
  JSON_BODY: '256kb',
  JSON_BODY_WITH_IMAGE: '3mb', // routes that carry a base64 image field

  // Base64 image fields stored inline in Firestore docs (1 MB doc ceiling).
  // Matches the existing admin-client check; migrating images to object storage
  // is the real fix (deferred — "harden in place" decision).
  IMAGE_MAX_BYTES: 900 * 1024,
  IMAGE_MIME_ALLOW: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],

  // Cart / order
  ITEM_QTY_MIN: 1,
  ITEM_QTY_MAX: 50,

  // OTP
  OTP_TTL_MS: 10 * 60 * 1000,        // 10 minutes
  OTP_MAX_ATTEMPTS: 5,
  OTP_LOCK_MS: 15 * 60 * 1000,       // lock the email for 15 min after too many attempts

  // Login lockout (P1 uses this; defined here for the shared constant)
  LOGIN_MAX_ATTEMPTS: 8,
  LOGIN_LOCK_MS: 15 * 60 * 1000,

  // Chat
  CHAT_MESSAGE_MAX_LEN: 2000,

  // Generic list caps
  LIST_LIMIT_MAX: 100,
});

module.exports = {
  ROLES,
  PRIVILEGED_ROLES,
  ORDER_STATES,
  ORDER_TRANSITIONS,
  REFUNDABLE_STATES,
  LIMITS,
};
