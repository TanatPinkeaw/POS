// Seam under test: who LINE messages are for, and what may ride on each (ADR 0030).
//
// Pure decisions, pinned without a database: the customer planner's four
// conditions are the gate between a waiting parcel and a push, and the shop-fact
// planners are the two sentences the counter hears. The rule ADR 0007 decision 3
// wrote — the collection code never reaches the shop's own group — is what the
// customer planner's nulls are *for*, so every null is named.
import { describe, expect, it } from 'vitest';

import {
  lineCustomerNotifyBlock,
  planLineCustomerReadyMessage,
  planShopFactMessage,
  planShopInboundDismissedMessage,
} from '@/lib/line-notify';

const HOLDS_UNTIL = new Date('2026-10-06T18:00:00+07:00');

/** A customer the planner is happy to tell: bound, consented, friended, LINE shop. */
function happy(overrides: Partial<Parameters<typeof lineCustomerNotifyBlock>[0]> = {}) {
  return {
    channel: 'line' as const,
    staffTo: 'Cgroup-of-staff',
    customerLineSubject: 'Ucustomer',
    consentAt: new Date('2026-10-01T09:00:00+07:00'),
    isFriend: true,
    ...overrides,
  };
}

describe('the customer planner', () => {
  it('plans the code to the customer`s own subject when every condition holds', () => {
    const plan = planLineCustomerReadyMessage({
      orderId: '11111111-2222-3333-4444-555555555555',
      orderNumber: 'PO-20261006-000001',
      pickupPin: '7391',
      holdUntil: HOLDS_UNTIL,
      ...happy(),
    });

    expect(plan).not.toBeNull();
    expect(plan?.recipient).toBe('Ucustomer');
    expect(plan?.text).toContain('7391');
    expect(plan?.text).not.toContain('Cgroup-of-staff');
    // The subject is the recipient; the group never appears in the message at all.
    expect(plan?.text).not.toContain('Ucustomer');
  });

  it('names each reason a customer cannot be told, and plans nothing for it', () => {
    const cases: {
      block: ReturnType<typeof lineCustomerNotifyBlock>;
      input: Partial<Parameters<typeof lineCustomerNotifyBlock>[0]>;
    }[] = [
      { block: 'not_bound', input: { customerLineSubject: null } },
      { block: 'no_consent', input: { consentAt: null } },
      { block: 'not_a_friend', input: { isFriend: false } },
      { block: 'channel_not_line', input: { channel: 'webhook' as const } },
    ];

    for (const { block, input } of cases) {
      expect(lineCustomerNotifyBlock(happy(input))).toBe(block);

      const plan = planLineCustomerReadyMessage({
        orderId: '11111111-2222-3333-4444-555555555555',
        orderNumber: 'PO-20261006-000001',
        pickupPin: '7391',
        holdUntil: HOLDS_UNTIL,
        ...happy(input),
      });
      expect(plan).toBeNull();
    }
  });

  it('never falls back to the shop`s group for a blocked customer', () => {
    // The one sentence ADR 0007 decision 3 exists for: the code belongs to the
    // customer's own phone, and the group is a room of staff phones.
    const plan = planLineCustomerReadyMessage({
      orderId: '11111111-2222-3333-4444-555555555555',
      orderNumber: 'PO-20261006-000001',
      pickupPin: '7391',
      holdUntil: HOLDS_UNTIL,
      ...happy({ isFriend: false }),
    });

    expect(plan).toBeNull();
  });
});

describe('the shop-fact planner', () => {
  it('tells the shop`s own destination about a refund, naming the reason', () => {
    const fact = planShopFactMessage({
      channel: 'line',
      staffTo: 'Cgroup-of-staff',
      orderId: '11111111-2222-3333-4444-555555555555',
      orderNumber: 'RC-2026-000123',
      reason: 'สินค้าชำรุด',
      refundedThb: 107,
    });

    expect(fact).not.toBeNull();
    expect(fact?.kind).toBe('order_refunded');
    expect(fact?.recipient).toBe('Cgroup-of-staff');
    expect(fact?.text).toContain('RC-2026-000123');
    expect(fact?.text).toContain('107');
    expect(fact?.text).toContain('สินค้าชำรุด');
    // The fact rides the order, so the dedupe is the order's own.
    expect(fact?.orderId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('plans nothing when the shop configured nothing', () => {
    // "Unset means nothing is queued" — the rule the outbox was opened under.
    expect(
      planShopFactMessage({
        channel: null,
        staffTo: 'Cgroup-of-staff',
        orderId: 'o',
        orderNumber: 'RC-1',
        reason: 'x',
        refundedThb: 1,
      }),
    ).toBeNull();
    expect(
      planShopFactMessage({
        channel: 'line',
        staffTo: null,
        orderId: 'o',
        orderNumber: 'RC-1',
        reason: 'x',
        refundedThb: 1,
      }),
    ).toBeNull();
  });

  it('keeps the refund fact off the customer channel', () => {
    // The fact is *about the shop's money*; it goes where the shop reads it,
    // whatever channel that is — but it names no customer and no code.
    const fact = planShopFactMessage({
      channel: 'webhook',
      staffTo: '0812345678',
      orderId: 'o',
      orderNumber: 'RC-1',
      reason: 'x',
      refundedThb: 1,
    });
    expect(fact?.channel).toBe('webhook');
    expect(fact?.recipient).toBe('0812345678');
  });

  it('tells the shop about a dismissed transfer, deduped on the transfer itself', () => {
    const fact = planShopInboundDismissedMessage({
      channel: 'line',
      staffTo: 'Cgroup-of-staff',
      transferId: '4242',
      amountThb: 350,
      reason: 'ไม่ใช่ยอดขาย',
    });

    expect(fact).not.toBeNull();
    expect(fact?.kind).toBe('inbound_dismissed');
    // No order exists for this fact, so the recipient column *is* the thing it
    // names — the same trick the inbound_payments row uses for its own idempotency.
    expect(fact?.recipient).toBe('4242');
    expect(fact?.orderId).toBeNull();
    expect(fact?.text).toContain('350');
  });

  it('says the amount was unreadable rather than inventing a figure', () => {
    const fact = planShopInboundDismissedMessage({
      channel: 'line',
      staffTo: 'Cgroup-of-staff',
      transferId: '4242',
      amountThb: null,
      reason: 'ไม่ใช่ยอดขาย',
    });

    expect(fact?.text).toContain('ยอดไม่อ่านได้');
    expect(fact?.text).not.toContain('null');
  });
});
