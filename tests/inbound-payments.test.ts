// Seam under test: money that arrives from a bank notification, against a real
// database.
//
// The unit half of the matcher (`inbound-match.test.ts`) pins the decisions; this
// file pins what happens around them, which is where money actually goes missing:
// a notification recorded twice, a confirmation that races the cashier, a row
// that claims to have closed a bill with nothing behind it. Every assertion is
// observable state — a row, a status, an audit entry — never an internal.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { openShift } from '@/lib/cash-shifts';
import { ConflictError, ValidationError } from '@/lib/errors';
import {
  dismissInboundTransfer,
  inboundDaySummary,
  listInboundTransfers,
  recordInboundTransfer,
} from '@/lib/inbound-payments';
import { confirmIntent, createIntent, findIntent, type PaymentIntentView } from '@/lib/payment-intents';
import { createShop } from '@/lib/shop';

import { prisma, resetDatabase, seedPeople, type TestPeople } from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A shop that can take PromptPay, with an open drawer.
 *
 * The shop is a singleton (`CHECK (id = 1)`), so it is created once and the
 * drawer is what a case that needs two QRs reuses — two `createShop` calls would
 * be testing the singleton, not the transfers.
 */
async function openShop(): Promise<{ shiftId: number }> {
  await createShop({
    name: 'เหลี่ยมนอก มินิมาร์ท',
    isVatRegistered: false,
    vatRate: 0,
    receiptPrefix: 'SMK',
    promptpayId: '0812345678',
    promptpayType: 'mobile',
  });
  const shift = await openShift({ userId: people.employeeId, initialCash: 500 });
  return { shiftId: shift.id };
}

/** A QR on the drawer, for one amount. */
async function qr(shiftId: number, amountThb: number): Promise<PaymentIntentView> {
  return createIntent({ shiftId, cashierId: people.employeeId, amountThb });
}

describe('money that names a bill', () => {
  it('closes it, and records where the money came from', async () => {
    const { shiftId } = await openShop();
    const intent = await qr(shiftId, 107);

    const record = await recordInboundTransfer({
      amountThb: 107,
      // The shop's own QR reference, quoted the way a customer's memo would
      // carry it — so the match is a real one rather than a coincidence of the
      // fixture.
      text: `รับเงินโอน 107.00 บาท ${intent.ref}`,
      source: 'bank-bridge',
      externalId: 'mail-1',
    });

    expect(record.status).toBe('matched');
    expect(record.intentRef).toBe(intent.ref);
    expect(record.refusalReason).toBeNull();

    // The intent is what the till polls, and the till closes the sale against it.
    const after = await findIntent(intent.ref);
    expect(after?.status).toBe('paid');
  });

  it('matches on the amount even when several QRs are open', async () => {
    const { shiftId } = await openShop();
    const small = await qr(shiftId, 60);
    const large = await qr(shiftId, 250);

    const record = await recordInboundTransfer({
      amountThb: 250,
      text: `โอน 250.00 เข้าร้าน ${large.ref}`,
      source: 'bank-bridge',
    });

    expect(record.intentRef).toBe(large.ref);
    expect((await findIntent(large.ref))?.status).toBe('paid');
    // The other QR is untouched: it is still on somebody's screen, waiting.
    expect((await findIntent(small.ref))?.status).toBe('pending');
  });
});

describe('money nobody can attribute', () => {
  it('is recorded rather than dropped, with the reason it was refused', async () => {
    const { shiftId } = await openShop();
    const intent = await qr(shiftId, 107);

    const record = await recordInboundTransfer({
      amountThb: 107,
      text: 'รับเงินโอน 107.00 บาท จาก นายสมชาย',
      source: 'bank-bridge',
    });

    expect(record.status).toBe('unmatched');
    expect(record.refusalReason).toBe('no_reference');
    expect(record.intentRef).toBeNull();
    // Named on the record, so the person who sorts it out knows which QR to look
    // at — and the QR itself is still payable, because nothing was decided.
    expect(record.rawText).toContain('นายสมชาย');
    expect((await findIntent(intent.ref))?.status).toBe('pending');

    const listed = await listInboundTransfers();
    expect(listed.map((row) => row.id)).toEqual([record.id]);
  });

  it('records an amount that matches no QR at all', async () => {
    const { shiftId } = await openShop();
    await qr(shiftId, 107);

    const record = await recordInboundTransfer({
      amountThb: 200,
      text: 'โอน 200.00 K7M2QX',
      source: 'bank-bridge',
    });

    expect(record.status).toBe('unmatched');
    expect(record.refusalReason).toBe('no_amount_match');
  });

  it('refuses money for a QR that was withdrawn before it arrived', async () => {
    const { shiftId } = await openShop();
    const intent = await qr(shiftId, 107);

    /*
     * Arrival is the bank's instant, not the moment the bridge got round to
     * posting: a notification that sat in a mailbox for an hour was still a
     * payment made inside the window. An hour from now, the QR's five minutes are
     * long gone.
     */
    const record = await recordInboundTransfer({
      amountThb: 107,
      text: `โอน ${intent.ref}`,
      source: 'bank-bridge',
      receivedAt: new Date(Date.now() + 3_600_000),
    });

    expect(record.status).toBe('unmatched');
    expect(record.refusalReason).toBe('not_payable');
    expect((await findIntent(intent.ref))?.status).toBe('pending');
  });

  it('refuses money for a bill that was already closed, without disturbing it', async () => {
    const { shiftId } = await openShop();
    const intent = await qr(shiftId, 107);
    await confirmIntent({ ref: intent.ref, confirmedByUserId: people.adminId });
    const paidAt = (await findIntent(intent.ref))?.paidAt;

    const record = await recordInboundTransfer({
      amountThb: 107,
      text: `โอน ${intent.ref}`,
      source: 'bank-bridge',
    });

    expect(record.refusalReason).toBe('not_payable');
    // Still paid, still at the same instant: a second notification cannot pay a
    // bill twice, and cannot rewrite when it was paid either.
    expect((await findIntent(intent.ref))?.paidAt).toEqual(paidAt);
  });

  it('refuses a transfer of nothing', async () => {
    await openShop();

    await expect(
      recordInboundTransfer({ amountThb: 0, text: 'zero', source: 'bank-bridge' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.inbound_payments.count()).toBe(0);
  });

  it('keeps a notification it could not read a number out of, rather than drop it', async () => {
    await openShop();

    /*
     * The bridge could not make sense of this bank's wording. Dropping it would
     * leave money in the account that this system has no record of; inventing an
     * amount would be worse. So the text is kept and the figure is honestly
     * absent, and it is filed as unreadable rather than as a mismatched amount.
     */
    const record = await recordInboundTransfer({
      amountThb: null,
      text: 'มีเงินเข้าบัญชี จำนวนหนึ่ง บาท',
      source: 'bank-bridge',
      externalId: 'mail-unreadable',
    });

    expect(record.amountThb).toBeNull();
    expect(record.status).toBe('unmatched');
    expect(record.refusalReason).toBe('amount_unreadable');
    expect(record.rawText).toContain('มีเงินเข้าบัญชี');
    expect(await listInboundTransfers()).toHaveLength(1);
  });
});

describe('a bridge that retries', () => {
  it('records one bank message once, and closes one bill', async () => {
    const { shiftId } = await openShop();
    const intent = await qr(shiftId, 107);
    const notification = {
      amountThb: 107,
      text: `โอน ${intent.ref} 107.00`,
      source: 'bank-bridge',
      externalId: 'mail-42',
    };

    const first = await recordInboundTransfer(notification);
    const second = await recordInboundTransfer(notification);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    // One notification, one row, one confirmation of the same bill.
    expect(await prisma.inbound_payments.count()).toBe(1);
    expect(second.intentRef).toBe(intent.ref);
    expect((await findIntent(intent.ref))?.status).toBe('paid');
  });

  it('records two different messages for the same amount as two transfers', async () => {
    await openShop();

    await recordInboundTransfer({
      amountThb: 107,
      text: 'โอน 107.00',
      source: 'bank-bridge',
      externalId: 'mail-1',
    });
    await recordInboundTransfer({
      amountThb: 107,
      text: 'โอน 107.00',
      source: 'bank-bridge',
      externalId: 'mail-2',
    });

    expect(await prisma.inbound_payments.count()).toBe(2);
  });
});

describe('money a person says is not ours', () => {
  it('is dismissed with a reason, and leaves the list', async () => {
    await openShop();
    const record = await recordInboundTransfer({
      amountThb: 9,
      text: 'โอน 9.00 จากบัญชีส่วนตัว',
      source: 'bank-bridge',
    });

    const dismissed = await dismissInboundTransfer({
      id: record.id,
      actorId: people.adminId,
      reason: 'โอนเข้าผิดบัญชี ไม่ใช่ยอดขาย',
    });

    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.dismissedReason).toBe('โอนเข้าผิดบัญชี ไม่ใช่ยอดขาย');
    expect(await listInboundTransfers()).toEqual([]);

    const audit = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'inbound_transfer_dismissed' },
    });
    expect(audit.actor_user_id).toBe(people.adminId);
    expect(audit.target_type).toBe('inbound_payment');
    expect(audit.target_id).toBe(record.id);
    expect(audit.detail).toMatchObject({ amountThb: 9 });
  });

  it('lets only the first of two people closing it have their reason kept', async () => {
    await openShop();
    const record = await recordInboundTransfer({
      amountThb: 9,
      text: 'โอน 9.00',
      source: 'bank-bridge',
    });

    await dismissInboundTransfer({ id: record.id, actorId: people.adminId, reason: 'คนแรก' });

    // The second is refused rather than silently overwriting the first's reason —
    // otherwise both audit rows would describe decisions that are not both true.
    await expect(
      dismissInboundTransfer({ id: record.id, actorId: people.employeeId, reason: 'คนที่สอง' }),
    ).rejects.toBeInstanceOf(ConflictError);

    const row = await prisma.inbound_payments.findUniqueOrThrow({ where: { id: BigInt(record.id) } });
    expect(row.dismissed_reason).toBe('คนแรก');
    expect(row.dismissed_by_user_id).toBe(people.adminId);
  });

  it('demands a reason, because the bank cannot be asked again', async () => {
    await openShop();
    const record = await recordInboundTransfer({
      amountThb: 9,
      text: 'โอน 9.00',
      source: 'bank-bridge',
    });

    await expect(
      dismissInboundTransfer({ id: record.id, actorId: people.adminId, reason: '   ' }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect((await listInboundTransfers()).map((row) => row.id)).toEqual([record.id]);
  });
});

describe("a day's transfers, added up", () => {
  it('counts what matched and what did not, and the money in each', async () => {
    const { shiftId } = await openShop();
    const intent = await qr(shiftId, 107);

    await recordInboundTransfer({
      amountThb: 107,
      text: `โอน ${intent.ref}`,
      source: 'bank-bridge',
    });
    await recordInboundTransfer({
      amountThb: 11,
      text: 'โอน 11.00',
      source: 'bank-bridge',
    });

    const today = await inboundDaySummary();
    expect(today).toEqual({
      matchedCount: 1,
      matchedThb: 107,
      unmatchedCount: 1,
      unmatchedThb: 11,
      dismissedCount: 0,
    });

    /*
     * And yesterday's money is not today's. The window is the *bank's* day, built
     * from Bangkok rather than from the process's timezone, so a transfer made at
     * 23:50 belongs to the day it was made however late the bridge posted it.
     */
    const tomorrow = await inboundDaySummary(new Date(Date.now() + 24 * 60 * 60 * 1000));
    expect(tomorrow.matchedCount).toBe(0);
    expect(tomorrow.unmatchedThb).toBe(0);
  });

  it('counts money it could not read without inventing a figure for it', async () => {
    await openShop();
    await recordInboundTransfer({
      amountThb: null,
      text: 'มีเงินเข้าบัญชี',
      source: 'bank-bridge',
    });

    const today = await inboundDaySummary();
    // The count says something is waiting; the sum stays empty, because a sum of
    // one unknown and nothing else is not zero — it is unknown.
    expect(today.unmatchedCount).toBe(1);
    expect(today.unmatchedThb).toBe(0);
  });
});

describe('what the list shows', () => {
  it('shows only what nobody has dealt with, newest first', async () => {
    const { shiftId } = await openShop();
    const intent = await qr(shiftId, 107);

    const older = await recordInboundTransfer({
      amountThb: 11,
      text: 'โอน 11.00',
      source: 'bank-bridge',
    });
    const newer = await recordInboundTransfer({
      amountThb: 12,
      text: 'โอน 12.00',
      source: 'bank-bridge',
    });
    const matched = await recordInboundTransfer({
      amountThb: 107,
      text: `โอน ${intent.ref}`,
      source: 'bank-bridge',
    });

    const listed = await listInboundTransfers();
    expect(listed.map((row) => row.id)).toEqual([newer.id, older.id]);
    // A matched transfer has a home already; it is not somebody's to-do.
    expect(listed.map((row) => row.id)).not.toContain(matched.id);
    expect((await listInboundTransfers({ status: 'matched' })).map((row) => row.id)).toEqual([
      matched.id,
    ]);
  });
});

describe('the guarantees the database keeps', () => {
  it('refuses a row that claims to have closed a bill but names none', async () => {
    await openShop();

    await expect(
      prisma.inbound_payments.create({
        data: {
          amount: 107,
          received_at: new Date(),
          source: 'bank-bridge',
          raw_text: 'โอน 107.00',
          status: 'matched',
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a row with no amount that does not say the amount was unreadable', async () => {
    await openShop();

    // The pairing is the point: a missing figure must be *explained*, and only
    // one reason explains it.
    await expect(
      prisma.inbound_payments.create({
        data: {
          received_at: new Date(),
          source: 'bank-bridge',
          raw_text: 'โอนเท่าไรไม่รู้',
          status: 'unmatched',
          refusal_reason: 'no_reference',
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses the same bank message recorded twice, whatever the application does', async () => {
    await openShop();

    const row = {
      amount: 107,
      received_at: new Date(),
      source: 'bank-bridge',
      external_id: 'mail-7',
      raw_text: 'โอน 107.00',
      status: 'unmatched' as const,
      refusal_reason: 'no_reference' as const,
    };
    await prisma.inbound_payments.create({ data: row });

    await expect(prisma.inbound_payments.create({ data: row })).rejects.toThrow();
  });
});
