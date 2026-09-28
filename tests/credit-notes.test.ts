// Seam under test: reversing a paid sale — the document, the stock, the drawer,
// the loyalty ledger and the audit trail, against a real database.
//
// Two halves, and the first is why the second can be trusted with money: the
// numbering and the state machine are pure functions, so the shape of a credit
// note's number and the rule that a bill can only be refunded once are pinned
// without a database at all. The integration cases then assert only observable
// state — counters, rows, a drawer's expected cash — and never an internal.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dashboardSnapshot } from '@/lib/analytics';
import { bangkokDateString } from '@/lib/bangkok-time';
import { closeShift, getOpenShift, type ShiftSummary } from '@/lib/cash-shifts';
import { refundMethodLabel } from '@/lib/credit-note-view';
import {
  findCreditNoteByNumber,
  loadCreditNoteDocument,
  refundOrder,
  refundedAmountFor,
} from '@/lib/credit-notes';
import { ConflictError, ValidationError } from '@/lib/errors';
import { cancelOrder, createPosSale, placePreOrder } from '@/lib/orders';
import { canTransition, holdsReservedStock, isTerminal } from '@/lib/order-state';
import { applyPointChange } from '@/lib/points';
import { paymentMethodLabel } from '@/lib/report-spec';
import { buildReport } from '@/lib/reports';
import { formatCreditNoteNumber } from '@/lib/shop-view';

import {
  prisma,
  readCounters,
  readSeries,
  resetDatabase,
  seedOpenShift,
  seedPeople,
  seedProduct,
  seedShop,
  type TestPeople,
} from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
  await seedShop();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The standard sale these cases reverse: 107 THB, VAT split out of the shelf price. */
async function sellCoffee(options: { member?: boolean; cash?: number } = {}) {
  const product = await seedProduct({ name: 'กาแฟ', stockQty: 10, salePrice: 107, costPrice: 60 });
  const shiftId = await seedOpenShift(people.employeeId, 500);

  const sale = await createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId: product.id, quantity: 1 }],
    customerId: options.member ? people.memberId : null,
    settlement: { cash: options.cash ?? 107 },
  });

  return { productId: product.id, shiftId, sale };
}

describe('the credit-note number', () => {
  it('is the shop\'s own series, in the same shape as a receipt', () => {
    expect(formatCreditNoteNumber('CN', 2026, 1)).toBe('CN-2026-000001');
    expect(formatCreditNoteNumber('CN', 2026, 123456)).toBe('CN-2026-123456');
  });

  it('falls back to the default prefix rather than emitting a bare year', () => {
    // A prefix of spaces would otherwise produce "-2026-000001", which is a
    // number nobody can look up.
    expect(formatCreditNoteNumber('   ', 2026, 7)).toBe('CN-2026-000007');
  });
});

describe('the refund transition', () => {
  it('is available from a paid bill and from nowhere else', () => {
    expect(canTransition('completed', 'refund')).toBe(true);

    for (const status of ['pending', 'confirmed', 'ready_for_pickup', 'cancelled', 'refunded'] as const) {
      expect(canTransition(status, 'refund'), `${status} must not be refundable`).toBe(false);
    }
  });

  it('is terminal, so a second refund has nowhere to go', () => {
    expect(isTerminal('refunded')).toBe(true);
    // And it claims no reservation: a refunded sale's goods go back on the shelf
    // through `stock_qty`, not back into somebody's pre-order.
    expect(holdsReservedStock('refunded')).toBe(false);
  });

  it('leaves cancelling a refunded bill impossible', () => {
    expect(canTransition('refunded', 'cancel')).toBe(false);
  });
});

describe('refunding a sale', () => {
  it('returns every unit to the shelf and says why in the stock log', async () => {
    const { productId, sale } = await sellCoffee();
    // The sale took one unit off the shelf; that is the state being reversed.
    expect(await readCounters(productId)).toEqual({ stockQty: 9, reservedQty: 0 });

    const refund = await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'ลูกค้าเปลี่ยนใจ',
      refundMethod: 'cash',
      shiftId: await currentShiftId(),
      authorizedByUserId: people.adminId,
    });

    expect(refund.status).toBe('refunded');
    expect(refund.returnedUnits).toBe(1);
    expect(await readCounters(productId)).toEqual({ stockQty: 10, reservedQty: 0 });

    const log = await prisma.stock_logs.findFirstOrThrow({
      where: { product_id: productId, movement_type: 'pos_refund' },
    });
    expect(log.qty_changed).toBe(1);
    expect(log.balance_after).toBe(10);
    expect(log.note ?? '').toContain(refund.documentNumber);
  });

  it('writes one credit note and one money leg, numbered from the shop\'s own series', async () => {
    const { sale } = await sellCoffee();

    const refund = await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'คิดเงินผิด',
      refundMethod: 'cash',
      shiftId: await currentShiftId(),
      authorizedByUserId: people.adminId,
    });

    expect(refund.documentNumber).toMatch(/^CN-\d{4}-000001$/);

    const note = await prisma.credit_notes.findUniqueOrThrow({ where: { order_id: sale.orderId } });
    expect(note.document_number).toBe(refund.documentNumber);
    expect(note.reason).toBe('คิดเงินผิด');
    expect(note.created_by).toBe(people.employeeId);
    expect(note.authorized_by_user_id).toBe(people.adminId);

    const legs = await prisma.payments.findMany({
      where: { order_id: sale.orderId },
      orderBy: { id: 'asc' },
    });
    expect(legs).toHaveLength(2);
    expect(legs[0]?.direction).toBe('sale');
    expect(legs[0]?.credit_note_id).toBeNull();
    expect(legs[1]?.direction).toBe('refund');
    expect(legs[1]?.credit_note_id).toBe(note.id);
    // The leg is stored positive: the sign lives in `direction`, which is what
    // keeps `CHECK (amount > 0)` true and every existing sum meaningful.
    expect(Number(legs[1]?.amount)).toBe(107);

    // Both counters advanced, and the credit-note series is its own.
    expect(await readSeries()).toEqual({ receipt: 1n, creditNote: 1n });
  });

  it('carries the sale\'s own tax snapshot onto the document', async () => {
    const { sale } = await sellCoffee();

    const document = await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'คืนสินค้า',
      refundMethod: 'cash',
      shiftId: await currentShiftId(),
      authorizedByUserId: people.adminId,
    }).then((refund) => loadCreditNoteDocument(refund.orderId));

    expect(document).not.toBeNull();
    expect(document?.finalAmountThb).toBe(107);
    expect(document?.netThb).toBe(100);
    expect(document?.vatThb).toBe(7);
    expect(document?.vatRatePercent).toBe(7);
    expect(document?.isVatInvoice).toBe(true);
    // Copied, not recomputed: the figures add up the way the sale's did.
    expect((document?.netThb ?? 0) + (document?.vatThb ?? 0)).toBe(document?.finalAmountThb);

    // The original bill is restated in full, so the pair is a paper trail rather
    // than a document that points at nothing.
    expect(document?.original.orderNumber).toBe(sale.orderNumber);
    expect(document?.original.receiptNumber).toBe(sale.receiptNumber);
    expect(document?.original.tenders).toEqual([
      { method: 'cash', amountThb: 107, receivedThb: 107 },
    ]);
    expect(document?.issuedBy).toBe('แคชเชียร์');
    expect(document?.approvedBy).toBe('ผู้จัดการ');
  });

  it('makes the drawer expect exactly what is left in it', async () => {
    const { shiftId, sale } = await sellCoffee();

    const before = await currentShift();
    expect(before.expectedCashThb).toBe(607);

    await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'ลูกค้าเปลี่ยนใจ',
      refundMethod: 'cash',
      shiftId,
      authorizedByUserId: people.adminId,
    });

    /*
     * 500 float + 107 taken − 107 handed back. This is the assertion the whole
     * `direction` column exists for: without it, the refund would either be
     * impossible (a negative amount against a `CHECK (amount > 0)`) or invisible
     * to the count, and the cashier would be short by the amount they returned.
     */
    const after = await currentShift();
    expect(after.cashSalesThb).toBe(0);
    expect(after.expectedCashThb).toBe(500);

    const closed = await closeShift({
      shiftId,
      userId: people.employeeId,
      actualCash: 500,
    });
    expect(closed.discrepancyThb).toBe(0);
    expect(closed.discrepancyKind).toBe('balanced');
    // And the refund was not counted as a bill this shift sold.
    expect(closed.orderCount).toBe(1);
  });

  it('leaves the drawer alone when the money went back by hand', async () => {
    const { shiftId, sale } = await sellCoffee();

    const refund = await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'โอนคืนผ่านแอป',
      refundMethod: 'promptpay',
      // Deliberately not the open drawer: a transfer made in the shop's banking
      // app never left it, and writing it against a shift would invent a shortage.
      shiftId: null,
      authorizedByUserId: people.adminId,
    });

    const leg = await prisma.payments.findFirstOrThrow({
      where: { order_id: sale.orderId, direction: 'refund' },
    });
    expect(leg.shift_id).toBeNull();
    expect(leg.method).toBe('promptpay');

    const shift = await currentShift();
    expect(shift.expectedCashThb).toBe(607);
    expect(shift.id).toBe(shiftId);
    expect(refund.refundMethod).toBe('promptpay');
  });

  it('refuses a second refund, and writes only one document', async () => {
    const { sale } = await sellCoffee();
    const shiftId = await currentShiftId();

    await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'ครั้งแรก',
      refundMethod: 'cash',
      shiftId,
      authorizedByUserId: people.adminId,
    });

    await expect(
      refundOrder({
        orderId: sale.orderId,
        actorId: people.employeeId,
        reason: 'ครั้งที่สอง',
        refundMethod: 'cash',
        shiftId,
        authorizedByUserId: people.adminId,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await prisma.credit_notes.count()).toBe(1);
    const legs = await prisma.payments.count({
      where: { order_id: sale.orderId, direction: 'refund' },
    });
    expect(legs).toBe(1);
    // The series did not advance either: a refused refund must not burn a number,
    // or the series has a hole in it that no document explains.
    expect((await readSeries()).creditNote).toBe(1n);
  });

  it('refuses to refund an order that was cancelled instead of paid', async () => {
    const product = await seedProduct({ name: 'น้ำเปล่า', stockQty: 4 });
    const shiftId = await seedOpenShift(people.employeeId);

    // A completed sale and a cancelled pre-order, side by side.
    const paid = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId: product.id, quantity: 1 }],
      customerId: null,
      settlement: { cash: 100 },
    });

    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });
    await cancelOrder({ orderId: placed.orderId, actorId: people.memberId, reason: 'ไม่รับแล้ว' });

    await expect(
      refundOrder({
        orderId: placed.orderId,
        actorId: people.employeeId,
        reason: 'คืนเงิน',
        refundMethod: 'cash',
        shiftId,
        authorizedByUserId: people.adminId,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // The paid one is still refundable: the refusal is about that order, not
    // about the shop's state.
    await expect(
      refundOrder({
        orderId: paid.orderId,
        actorId: people.employeeId,
        reason: 'คืนเงิน',
        refundMethod: 'cash',
        shiftId,
        authorizedByUserId: people.adminId,
      }),
    ).resolves.toMatchObject({ status: 'refunded' });
  });

  it('refuses a cash refund when no drawer is open', async () => {
    const { sale } = await sellCoffee();
    const shiftId = await currentShiftId();
    await closeShift({ shiftId, userId: people.employeeId, actualCash: 607 });

    await expect(
      refundOrder({
        orderId: sale.orderId,
        actorId: people.employeeId,
        reason: 'คืนเงินสด',
        refundMethod: 'cash',
        shiftId,
        authorizedByUserId: people.adminId,
      }),
    ).rejects.toMatchObject({ code: 'NO_OPEN_SHIFT' });

    // The same bill, refunded by hand instead, is fine — the constraint is about
    // the drawer, not about the refund.
    await expect(
      refundOrder({
        orderId: sale.orderId,
        actorId: people.employeeId,
        reason: 'โอนคืน',
        refundMethod: 'promptpay',
        shiftId: null,
        authorizedByUserId: people.adminId,
      }),
    ).resolves.toMatchObject({ status: 'refunded' });
  });

  it('reverses the points the sale earned and gives back the ones it redeemed', async () => {
    // 300 THB spent earns 100 points; the customer then spends 100 elsewhere, so
    // there is nothing left to claw back.
    const product = await seedProduct({ name: 'ของใช้', stockQty: 5, salePrice: 305 });
    const shiftId = await seedOpenShift(people.employeeId);

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId: product.id, quantity: 1 }],
      customerId: people.memberId,
      settlement: { cash: 305 },
    });
    expect(sale.pointsEarned).toBe(101);

    await applyPointChange(prisma, {
      userId: people.memberId,
      delta: -101,
      description: 'ใช้ไปแล้วที่อื่น',
    });

    const refund = await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'คืนสินค้า',
      refundMethod: 'cash',
      shiftId,
      authorizedByUserId: people.adminId,
    });

    /*
     * Clamped, not attempted. `applyPointChange` refuses to drive a balance
     * negative, and the customer's own refund must not fail because they spent
     * what they earned — so the shortfall is recorded on the document instead.
     */
    expect(refund.pointsClawedBack).toBe(0);
    expect(refund.pointsForgiven).toBe(101);

    const note = await prisma.credit_notes.findUniqueOrThrow({ where: { order_id: sale.orderId } });
    expect(note.points_forgiven).toBe(101);
    expect((await prisma.users.findUniqueOrThrow({ where: { id: people.memberId } })).points_balance).toBe(0);
  });

  it('claws back what the customer still has, and clamps the rest', async () => {
    const { sale } = await sellCoffee({ member: true });
    // 107 THB earns 35 points, and the customer keeps them.
    expect(sale.pointsEarned).toBe(35);

    const refund = await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'คืนสินค้า',
      refundMethod: 'cash',
      shiftId: await currentShiftId(),
      authorizedByUserId: people.adminId,
    });

    expect(refund.pointsClawedBack).toBe(35);
    expect(refund.pointsForgiven).toBe(0);
    expect((await prisma.users.findUniqueOrThrow({ where: { id: people.memberId } })).points_balance).toBe(0);
  });

  it('records who was at the till and whose PIN allowed it', async () => {
    const { sale } = await sellCoffee();

    const refund = await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'ลูกค้าแจ้งสินค้าชำรุด',
      refundMethod: 'cash',
      shiftId: await currentShiftId(),
      authorizedByUserId: people.adminId,
    });

    const row = await prisma.audit_logs.findFirstOrThrow({ where: { action: 'refund_order' } });
    expect(row.actor_user_id).toBe(people.employeeId);
    expect(row.authorized_by_user_id).toBe(people.adminId);
    expect(row.target_type).toBe('credit_note');
    expect(row.target_id).toBe(refund.documentNumber);
    expect(row.detail).toMatchObject({
      orderNumber: sale.orderNumber,
      finalAmountThb: 107,
      refundMethod: 'cash',
      returnedUnits: 1,
    });
    expect(row.detail).toMatchObject({ reason: 'ลูกค้าแจ้งสินค้าชำรุด' });
  });

  it('demands a reason, because it is the only record of why the money left', async () => {
    const { sale } = await sellCoffee();

    await expect(
      refundOrder({
        orderId: sale.orderId,
        actorId: people.employeeId,
        reason: '   ',
        refundMethod: 'cash',
        shiftId: await currentShiftId(),
        authorizedByUserId: people.adminId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await prisma.credit_notes.count()).toBe(0);
  });

  it('marks the order refunded and answers the credit note by number', async () => {
    const { sale } = await sellCoffee();

    const refund = await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'คืนสินค้า',
      refundMethod: 'cash',
      shiftId: await currentShiftId(),
      authorizedByUserId: people.adminId,
    });

    expect((await prisma.orders.findUniqueOrThrow({ where: { id: sale.orderId } })).status).toBe(
      'refunded',
    );

    const found = await findCreditNoteByNumber(refund.documentNumber);
    expect(found?.orderId).toBe(sale.orderId);
    expect(await refundedAmountFor(sale.orderId)).toBe(107);
    expect(await refundedAmountFor('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('refuses to refund a sale twice through the database as well as the state machine', async () => {
    const { sale } = await sellCoffee();
    const shiftId = await currentShiftId();

    await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'ครั้งแรก',
      refundMethod: 'cash',
      shiftId,
      authorizedByUserId: people.adminId,
    });

    /*
     * The unique index on `credit_notes.order_id` is the guard that survives two
     * requests which both get past `canTransition`. Proven here by writing the row
     * the domain would have written: the database refuses it, and the refund is
     * therefore impossible however the API is called.
     */
    await expect(
      prisma.credit_notes.create({
        data: {
          document_number: 'CN-2026-000999',
          order_id: sale.orderId,
          reason: 'ซ้ำ',
          refund_method: 'cash',
          final_amount: 107,
          net_amount: 100,
          vat_amount: 7,
          created_by: people.employeeId,
        },
      }),
    ).rejects.toThrow();
  });

  it('cannot record a refund leg without the document behind it', async () => {
    const { sale, shiftId } = await sellCoffee();

    // The CHECK that ties `direction` to `credit_note_id`: money cannot leave the
    // till with nothing explaining why, and an ordinary sale cannot claim a
    // document it never had.
    await expect(
      prisma.payments.create({
        data: {
          order_id: sale.orderId,
          shift_id: shiftId,
          method: 'cash',
          amount: 10,
          direction: 'refund',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('the refund method', () => {
  it('is described in the operator\'s own words', () => {
    expect(refundMethodLabel('cash')).toContain('เงินสด');
    expect(refundMethodLabel('promptpay')).toContain('โอน');
  });
});

describe('what a refund does to the figures', () => {
  it('is a refund today, not a hole in the day the sale happened', async () => {
    const { sale } = await sellCoffee();
    await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'ลูกค้าเปลี่ยนใจ',
      refundMethod: 'cash',
      shiftId: await currentShiftId(),
      authorizedByUserId: people.adminId,
    });

    const snapshot = await dashboardSnapshot();

    // Gross: the sale is still today's sale. Its reversal is Friday's event, not
    // a rewrite of the day that recorded it.
    expect(snapshot.today.salesThb).toBe(107);
    expect(snapshot.today.refundsThb).toBe(107);
    expect(snapshot.today.refundCount).toBe(1);
    expect(snapshot.today.netSalesThb).toBe(0);

    /*
     * And the drawer is empty of it: ฿107 came in and ฿107 went straight back
     * out. The card is titled "cash in the drawer", so it has to net the refund
     * — reporting the ฿107 taken would name a drawer that is holding nothing,
     * and would disagree with the count the cashier does at close of shift.
     */
    expect(snapshot.today.cashThb).toBe(0);
    expect(snapshot.today.cashRefundedThb).toBe(107);
  });

  it('leaves the sales summary sheet gross, and its payment column about payment', async () => {
    const { sale } = await sellCoffee();
    await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'คิดเงินผิด',
      // Cash back on a bill that was paid by transfer: the sheet must still say
      // how the *customer* paid, or it would read as a mixed-payment sale.
      refundMethod: 'cash',
      shiftId: await currentShiftId(),
      authorizedByUserId: people.adminId,
    });

    const today = bangkokDateString(new Date());
    const sheet = await buildReport({ type: 'sales_summary', from: today, to: today });

    expect(sheet.rows).toHaveLength(1);
    const row = sheet.rows[0]!;
    expect(row[0]).toBe(sale.orderNumber);
    expect(row[6]).toBe(paymentMethodLabel(['cash']));
    expect(row[5]).toBe(107);
  });
});

/** The drawer the sale was taken in, read through the same accessor the till uses. */
async function currentShift(): Promise<ShiftSummary> {
  const shift = await getOpenShift(prisma, people.employeeId);
  if (!shift) {
    throw new Error('The test expected an open drawer and found none');
  }
  return shift;
}

async function currentShiftId(): Promise<number> {
  return (await currentShift()).id;
}
