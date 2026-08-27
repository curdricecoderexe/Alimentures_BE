import { describe, it, expect } from 'vitest';
import {
  ORDER_STATES,
  ORDER_TRANSITIONS,
  REFUNDABLE_STATES,
  CUSTOMER_CANCELLABLE_STATES,
  ADMIN_CANCELLABLE_STATES,
  DELIVERY_ALLOWED_TARGET_STATES,
} from '../config/constants.js';

const ALL = Object.values(ORDER_STATES);

describe('order state machine', () => {
  it('every transition target is a real state', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      expect(ALL, `unknown source ${from}`).toContain(from);
      for (const t of targets) expect(ALL, `unknown target ${t} from ${from}`).toContain(t);
    }
  });

  it('never allows a self-transition', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      expect(targets, `${from} -> ${from}`).not.toContain(from);
    }
  });

  it('the fulfilment machine cannot reach cancelled or refunded', () => {
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      expect(targets).not.toContain('cancelled');
      expect(targets).not.toContain('refunded');
    }
  });

  it('terminal states have no outgoing fulfilment transitions', () => {
    for (const s of ['delivered', 'cancelled', 'refunded', 'payment_pending']) {
      expect(ORDER_TRANSITIONS[s] || []).toHaveLength(0);
    }
  });

  it('delivery personnel can only move an order toward delivery', () => {
    for (const s of DELIVERY_ALLOWED_TARGET_STATES) {
      expect(['out_for_delivery', 'delivered']).toContain(s);
    }
  });

  it('customers can cancel a strict subset of what admins can', () => {
    for (const s of CUSTOMER_CANCELLABLE_STATES) {
      expect(ADMIN_CANCELLABLE_STATES, `${s} not admin-cancellable`).toContain(s);
      expect(ALL).toContain(s);
    }
  });

  it('refundable states are all real and post-shipment', () => {
    for (const s of REFUNDABLE_STATES) {
      expect(ALL).toContain(s);
      expect(['shipped', 'out_for_delivery', 'delivered']).toContain(s);
    }
  });
});
