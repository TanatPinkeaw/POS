// Seam under test: who LINE messages are for, and what may ride on each (ADR 0030).
//
// Pure decisions, pinned without a database: the customer planner's four
// conditions are the gate between a waiting parcel and a push, and the shop-fact
// planners are the two sentences the counter hears. The rule ADR 0007 decision 3
// wrote — the collection code never reaches the shop's own group — is what the
// customer planner's nulls are *for*, so every null is named.
import { describe, expect, it } from 'vitest';

import {
  customerNoticeOutcome,
  lineCustomerNotifyBlock,
  planLineCustomerCancelledMessage,
  planLineCustomerConfirmedMessage,
  planLineCustomerReadyMessage,
  planLineCustomerReceiptMessage,
  planLineCustomerReminderMessage,
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

describe('the customer`s other order facts (ADR 0035)', () => {
  const ORDER = {
    orderId: '11111111-2222-3333-4444-555555555555',
    orderNumber: 'PO-20261019-000007',
  };
  /* A deployment with no LIFF app: the sentences must carry no dangling link. */
  const NO_ENV = {};

  it('tells the customer the order was accepted, and what changed if lines were dropped', () => {
    const plan = planLineCustomerConfirmedMessage(
      {
        ...ORDER,
        itemCount: 2,
        finalAmountThb: 240,
        removedCount: 1,
        ...happy(),
      },
      NO_ENV,
    );

    expect(plan?.recipient).toBe('Ucustomer');
    expect(plan?.text).toContain(ORDER.orderNumber);
    expect(plan?.text).toContain('2 รายการ');
    expect(plan?.text).toContain('240');
    // The dropped line is in the same sentence as the count: a customer who ordered
    // three must not learn about two only by arriving.
    expect(plan?.text).toContain('ตัดออก 1 รายการ');
  });

  it('says nothing about removed lines when nothing was removed', () => {
    const plan = planLineCustomerConfirmedMessage(
      { ...ORDER, itemCount: 1, finalAmountThb: 35, removedCount: 0, ...happy() },
      NO_ENV,
    );

    expect(plan?.text).not.toContain('ตัดออก');
  });

  it('tells the customer a cancellation with the shop`s own reason, and reports nothing when they cannot be reached', () => {
    const plan = planLineCustomerCancelledMessage(
      { ...ORDER, reason: 'สินค้าไม่พร้อม', ...happy() },
      NO_ENV,
    );

    expect(plan?.text).toContain('ถูกยกเลิก');
    expect(plan?.text).toContain('สินค้าไม่พร้อม');
    // Conditional, because an unpaid pre-order owes nobody a refund.
    expect(plan?.text).toContain('ถ้าโอนเงินมาแล้ว');

    expect(
      planLineCustomerCancelledMessage(
        { ...ORDER, reason: 'x', ...happy({ isFriend: false }) },
        NO_ENV,
      ),
    ).toBeNull();
  });

  it('reminds with the PIN and the hold, in Bangkok time', () => {
    const plan = planLineCustomerReminderMessage(
      { ...ORDER, pickupPin: '7391', holdUntil: HOLDS_UNTIL, ...happy() },
      NO_ENV,
    );

    expect(plan?.text).toContain('7391');
    // The hold was declared at 18:00 Bangkok; a server in another zone must not move it.
    expect(plan?.text).toContain('18:00');
    expect(plan?.text).toContain('ใกล้หมดเวลา');
  });

  it('carries the receipt link and states when it dies', () => {
    const expiresAt = new Date('2026-10-19T13:30:00+07:00');
    const plan = planLineCustomerReceiptMessage(
      {
        ...ORDER,
        receiptUrl: 'https://pos.example.com/receipts?t=signed',
        expiresAt,
        ...happy(),
      },
      NO_ENV,
    );

    expect(plan?.text).toContain('https://pos.example.com/receipts?t=signed');
    // A link that dies in an hour is only usable if the message says so.
    expect(plan?.text).toContain('13:30');
    expect(plan?.text).toContain('หน้าออเดอร์');
  });

  it('appends the in-app entry only when this deployment has one', () => {
    const plan = planLineCustomerReminderMessage(
      { ...ORDER, pickupPin: '7391', holdUntil: HOLDS_UNTIL, ...happy() },
      { LINE_LIFF_ID: '2000000000-abcdefgh' },
    );

    expect(plan?.text).toContain('https://liff.line.me/2000000000-abcdefgh');
  });
});

describe('the notice read back to the counter', () => {
  const READY = {
    channel: 'line' as const,
    customerLineSubject: 'Ucustomer',
    consentAt: new Date('2026-10-01T09:00:00+07:00'),
    isFriend: true,
    customerPhone: '0800000002',
    isReady: true,
  };

  it('reports the record before re-deriving anything', () => {
    expect(customerNoticeOutcome({ ...READY, notification: 'sent' }).state).toBe('sent');
    expect(customerNoticeOutcome({ ...READY, notification: 'pending' }).state).toBe('queued');

    // A message LINE refused after every retry is `failed` even though every condition
    // was satisfied when it was queued — the row is the record.
    const failed = customerNoticeOutcome({ ...READY, notification: 'abandoned' });
    expect(failed.state).toBe('failed');
    expect(failed.sentence).toContain('ไม่สำเร็จ');
  });

  it('says nothing at all about an order that is not ready', () => {
    const outcome = customerNoticeOutcome({ ...READY, isReady: false, notification: null });

    expect(outcome.state).toBe('not_ready');
    expect(outcome.sentence).toBeNull();
  });

  it('names the exact reason a LINE customer was not told', () => {
    const outcome = customerNoticeOutcome({ ...READY, isFriend: false, notification: null });

    expect(outcome.state).toBe('not_sent');
    expect(outcome.reason).toBe('not_a_friend');
    expect(outcome.sentence).toContain('เพิ่มเพื่อนร้าน');
  });

  it('separates "the shop configured nothing" from "this customer cannot be reached"', () => {
    const none = customerNoticeOutcome({ ...READY, channel: null, notification: null });
    expect(none.reason).toBe('no_channel');

    const webhook = customerNoticeOutcome({
      ...READY,
      channel: 'webhook',
      customerPhone: null,
      notification: null,
    });
    // A webhook shop texts; no phone is the failure, not the LINE binding.
    expect(webhook.reason).toBe('no_phone');

    const texted = customerNoticeOutcome({
      ...READY,
      channel: 'webhook',
      notification: null,
    });
    expect(texted.state).toBe('not_sent');
    expect(texted.reason).toBeNull();
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
