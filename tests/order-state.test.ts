// Seam under test: the 4-phase order lifecycle from SRS §3, as a pure machine.
import { describe, expect, it } from 'vitest';

import {
  type OrderAction,
  type OrderStatus,
  allowedActions,
  canTransition,
  holdsReservedStock,
  isTerminal,
  nextStatus,
} from '@/lib/order-state';

const ALL_STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'ready_for_pickup',
  'completed',
  'cancelled',
  'refunded',
];

const ALL_ACTIONS: OrderAction[] = ['confirm', 'mark_ready', 'complete', 'cancel', 'refund'];

describe('happy path', () => {
  it('walks pending → confirmed → ready_for_pickup → completed', () => {
    // SRS §3: the four phases, in order.
    expect(nextStatus('pending', 'confirm')).toBe('confirmed');
    expect(nextStatus('confirmed', 'mark_ready')).toBe('ready_for_pickup');
    expect(nextStatus('ready_for_pickup', 'complete')).toBe('completed');
  });

  it('refuses to skip a phase', () => {
    expect(canTransition('pending', 'mark_ready')).toBe(false);
    expect(canTransition('pending', 'complete')).toBe(false);
    expect(canTransition('confirmed', 'complete')).toBe(false);
    expect(canTransition('confirmed', 'confirm')).toBe(false);
  });
});

describe('cancellation', () => {
  it('is allowed from every live phase', () => {
    // SRS §3: each phase has its own terminal cancellation (expired,
    // out-of-stock, no-show), and every one of them restores stock.
    expect(canTransition('pending', 'cancel')).toBe(true);
    expect(canTransition('confirmed', 'cancel')).toBe(true);
    expect(canTransition('ready_for_pickup', 'cancel')).toBe(true);
    expect(nextStatus('ready_for_pickup', 'cancel')).toBe('cancelled');
  });

  it('is refused once the order is settled', () => {
    expect(canTransition('completed', 'cancel')).toBe(false);
    expect(canTransition('cancelled', 'cancel')).toBe(false);
  });
});

describe('states with no way forward', () => {
  it('accepts no further action once refunded or cancelled', () => {
    for (const action of ALL_ACTIONS) {
      expect(canTransition('cancelled', action)).toBe(false);
      expect(canTransition('refunded', action)).toBe(false);
    }
  });

  it('leaves no allowed actions from a refunded or cancelled order', () => {
    expect(allowedActions('cancelled')).toEqual([]);
    expect(allowedActions('refunded')).toEqual([]);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('refunded')).toBe(true);
  });

  it('leaves a completed sale exactly one way out, and it is the refund', () => {
    // The one transition that leaves what used to be a terminal state, and the
    // reason `isTerminal('completed')` is false: a paid bill can be reversed, so
    // "closed" and "finished" stopped being the same thing.
    expect(allowedActions('completed')).toEqual(['refund']);
    expect(isTerminal('completed')).toBe(false);
    expect(canTransition('completed', 'cancel')).toBe(false);
  });
});

describe('allowedActions', () => {
  it('lists the legal moves from each live phase', () => {
    expect(allowedActions('pending')).toEqual(['confirm', 'cancel']);
    expect(allowedActions('confirmed')).toEqual(['mark_ready', 'cancel']);
    expect(allowedActions('ready_for_pickup')).toEqual(['complete', 'cancel']);
  });
});

describe('nextStatus', () => {
  it('throws on an illegal transition rather than inventing a status', () => {
    expect(() => nextStatus('completed', 'confirm')).toThrow(/completed/);
    expect(() => nextStatus('cancelled', 'mark_ready')).toThrow(/cancelled/);
  });
});

describe('holdsReservedStock', () => {
  it('covers exactly phases 1 through 3', () => {
    // SRS §4.1: reserved_qty is claimed by active Phase 1–3 pre-orders.
    expect(holdsReservedStock('pending')).toBe(true);
    expect(holdsReservedStock('confirmed')).toBe(true);
    expect(holdsReservedStock('ready_for_pickup')).toBe(true);
    expect(holdsReservedStock('completed')).toBe(false);
    expect(holdsReservedStock('cancelled')).toBe(false);
    expect(holdsReservedStock('refunded')).toBe(false);
  });

  it('is stated on its own, not derived from isTerminal', () => {
    /*
     * These two agreed for as long as every terminal state was also a state that
     * held nothing. Refunds broke that: `completed` stopped being terminal while
     * still holding no reservation, so a derivation would now claim a paid sale is
     * sitting on somebody's pre-order. The disagreement is the contract.
     */
    expect(isTerminal('completed')).toBe(false);
    expect(holdsReservedStock('completed')).toBe(false);

    for (const status of ALL_STATUSES) {
      if (holdsReservedStock(status)) {
        expect(isTerminal(status), `${status} holds stock and must not be terminal`).toBe(false);
      }
    }
  });
});
