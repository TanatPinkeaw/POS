/**
 * Cash drawer (shift) management — SRS §6.2.
 *
 * A shift brackets the cash a till starts with and ends with. Orders settle
 * against an open shift, which is why a walk-in sale cannot complete without
 * one: the payment has to belong to a drawer to be reconcilable.
 */
import type { cash_shifts } from '../generated/prisma/client';

import { recordAudit } from './audit';
import { prisma } from './db';
import { optionalNumberEnv } from './env';
import { ConflictError, NotFoundError } from './errors';
import { fromDecimal, roundThb } from './money';
import { lockShopRow } from './shop';
import { classifyDiscrepancy, computeCashDiscrepancy, computeExpectedCash, type DiscrepancyKind } from './shifts';
import type { Db } from './inventory';

const TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 30_000 } as const;

export interface ShiftSummary {
  id: number;
  status: 'open' | 'closed';
  openedAt: Date;
  closedAt: Date | null;
  initialCashThb: number;
  cashSalesThb: number;
  /** Cash paid out to consignors from this drawer (ADR 0023 §6). */
  cashPayoutsThb: number;
  expectedCashThb: number;
  actualCashThb: number | null;
  discrepancyThb: number | null;
  discrepancyKind: DiscrepancyKind | null;
  orderCount: number;
}

/** The seeded default float, so a new till starts from the shop's usual amount. */
export function defaultInitialCash(): number {
  return optionalNumberEnv('DEFAULT_INITIAL_CASH_THB', 2000);
}

/**
 * Physical cash taken against a shift, net of what was handed back.
 *
 * Only `cash` rows count. PromptPay and points never enter the drawer, so
 * folding them in here would invent a discrepancy that does not exist — and the
 * same rule is what keeps a refund made by hand from the shop's banking app out
 * of this figure: it carries no `shift_id`, because it never touched a drawer.
 *
 * The sign is applied here rather than stored, because a `payments.amount` is a
 * magnitude and its `direction` says which way it went (see the migration). A
 * cash refund written against this shift therefore *reduces* what the drawer is
 * expected to hold, which is precisely what the cashier counts at close: if ฿107
 * went back to a customer, ฿107 is not in the till.
 */
async function cashSalesForShift(db: Db, shiftId: number): Promise<number> {
  const rows = await db.$queryRaw<{ total: unknown }[]>`
    SELECT COALESCE(
             SUM(CASE WHEN "direction" = 'refund' THEN -"amount" ELSE "amount" END),
             0
           ) AS total
      FROM "payments"
     WHERE "shift_id" = ${shiftId}
       AND "method"   = 'cash'
  `;
  const row = rows[0];
  return row ? Number(row.total) : 0;
}

/**
 * Cash paid out of this drawer to consignors (ADR 0023 §6).
 *
 * A cash payout names the drawer it came from, so the money is counted the same way a
 * cash refund is: it left the till, and the close-of-shift count must know. A transfer
 * carries no `shift_id` and never appears here.
 */
async function cashPayoutsForShift(db: Db, shiftId: number): Promise<number> {
  const rows = await db.$queryRaw<{ total: unknown }[]>`
    SELECT COALESCE(SUM("amount_thb"), 0) AS total
      FROM "consignor_payouts"
     WHERE "shift_id" = ${shiftId}
       AND "method" = 'cash'
  `;
  const row = rows[0];
  return row ? Number(row.total) : 0;
}

/**
 * How many bills this shift closed.
 *
 * Refund legs are excluded, and that is not bookkeeping pedantry: a refund leg
 * names the *refunding* shift and points at the sale it reverses, so counting it
 * would credit this shift with an order it did not sell — and would do it again
 * for whichever shift took the money in the first place.
 */
async function orderCountForShift(db: Db, shiftId: number): Promise<number> {
  const rows = await db.$queryRaw<{ order_count: unknown }[]>`
    SELECT COUNT(DISTINCT "order_id") AS order_count
      FROM "payments"
     WHERE "shift_id" = ${shiftId}
       AND "direction" = 'sale'
  `;
  const row = rows[0];
  return row ? Number(row.order_count) : 0;
}

/** Projects a raw `cash_shifts` row into the shape the UI consumes. */
async function summarize(db: Db, shift: cash_shifts): Promise<ShiftSummary> {
  const initialCashThb = fromDecimal(shift.initial_cash);
  const cashSalesThb = await cashSalesForShift(db, shift.id);
  const cashPayoutsThb = await cashPayoutsForShift(db, shift.id);
  const expectedCashThb = computeExpectedCash({
    initialCash: initialCashThb,
    cashSales: cashSalesThb,
    cashPayouts: cashPayoutsThb,
  });
  const actualCashThb = shift.actual_cash === null ? null : fromDecimal(shift.actual_cash);

  const discrepancyThb =
    actualCashThb === null
      ? null
      : computeCashDiscrepancy({
          initialCash: initialCashThb,
          cashSales: cashSalesThb,
          cashPayouts: cashPayoutsThb,
          actualCash: actualCashThb,
        });

  return {
    id: shift.id,
    status: shift.status,
    openedAt: shift.opened_at,
    closedAt: shift.closed_at,
    initialCashThb,
    cashSalesThb,
    cashPayoutsThb,
    expectedCashThb,
    actualCashThb,
    discrepancyThb,
    discrepancyKind: discrepancyThb === null ? null : classifyDiscrepancy(discrepancyThb),
    orderCount: await orderCountForShift(db, shift.id),
  };
}

/** The shift this employee currently has open, if any. */
export async function getOpenShift(db: Db, userId: string): Promise<ShiftSummary | null> {
  const shift = await db.cash_shifts.findFirst({
    where: { opened_by: userId, status: 'open' },
    orderBy: { opened_at: 'desc' },
  });
  return shift ? summarize(db, shift) : null;
}

/** Returns the employee's open shift, refusing to proceed without one. */
export async function requireOpenShift(db: Db, userId: string): Promise<ShiftSummary> {
  const shift = await getOpenShift(db, userId);
  if (!shift) {
    throw new ConflictError(
      'Open a cash drawer before taking payment',
      'NO_OPEN_SHIFT',
    );
  }
  return shift;
}

/** Opens a drawer with a starting float. */
export async function openShift(input: {
  userId: string;
  initialCash: number;
}): Promise<ShiftSummary> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.cash_shifts.findFirst({
      where: { opened_by: input.userId, status: 'open' },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(
        `You already have cash drawer #${existing.id} open. Close it before opening another.`,
        'SHIFT_ALREADY_OPEN',
      );
    }

    const shift = await tx.cash_shifts.create({
      data: {
        opened_by: input.userId,
        initial_cash: roundThb(input.initialCash),
        status: 'open',
      },
    });

    return summarize(tx, shift);
  }, TRANSACTION_OPTIONS);
}

/**
 * Closes the drawer and records the count.
 *
 * The row is locked first, so a double-tap on "Close drawer" cannot produce two
 * conflicting settlements — the second attempt sees `closed` and is refused.
 */
export async function closeShift(input: {
  shiftId: number;
  userId: string;
  actualCash: number;
}): Promise<ShiftSummary> {
  return prisma.$transaction(async (tx) => {
    // Same shop-first order as borrowing/replay: close cannot race a new loan.
    await lockShopRow(tx);
    const locked = await tx.$queryRaw<{ id: number; status: 'open' | 'closed' }[]>`
      SELECT "id", "status" FROM "cash_shifts" WHERE "id" = ${input.shiftId} FOR UPDATE
    `;
    const current = locked[0];
    if (!current) {
      throw new NotFoundError(`Cash drawer #${input.shiftId}`);
    }
    if (current.status === 'closed') {
      throw new ConflictError(
        `Cash drawer #${input.shiftId} is already closed`,
        'SHIFT_ALREADY_CLOSED',
      );
    }

    const existing = await tx.cash_shifts.findUniqueOrThrow({ where: { id: input.shiftId } });
    if (existing.opened_by !== input.userId) throw new ConflictError('ลิ้นชักนี้เป็นของผู้ใช้อื่น — ให้เจ้าของกะปิดลิ้นชัก', 'SHIFT_WRONG_OWNER');
    if (await tx.number_blocks.count({ where: { opened_by: existing.opened_by, reported_at: null, cancelled_at: null } })) {
      throw new ConflictError('ส่งบิลและคืนชุดเลขออฟไลน์ให้ครบก่อนปิดลิ้นชัก', 'SHIFT_OFFLINE_LOANS_OPEN');
    }
    const initialCashThb = fromDecimal(existing.initial_cash);
    const cashSalesThb = await cashSalesForShift(tx, input.shiftId);
    const cashPayoutsThb = await cashPayoutsForShift(tx, input.shiftId);
    const expectedCashThb = computeExpectedCash({
      initialCash: initialCashThb,
      cashSales: cashSalesThb,
      cashPayouts: cashPayoutsThb,
    });
    const actualCashThb = roundThb(input.actualCash);

    const updated = await tx.cash_shifts.update({
      where: { id: input.shiftId },
      data: {
        status: 'closed',
        closed_at: new Date(),
        closed_by: input.userId,
        expected_cash: expectedCashThb,
        actual_cash: actualCashThb,
      },
    });

    return summarize(tx, updated);
  }, TRANSACTION_OPTIONS);
}

/**
 * Records a drawer opened with no sale behind it.
 *
 * The classic no-sale kick, and the reason `drawer_open` is a gated action: it
 * is how change gets broken, how a float gets checked, and how a drawer gets
 * emptied when nobody is watching. A browser cannot push a physical drawer, so
 * what this writes is the *record* — the cashier still opens the till by hand.
 * That is the part that matters for an owner reading the trail later.
 *
 * It touches no money, which is why it is not a `payments` row and why the
 * reconciliation ignores it: this is an event log, not a till transaction.
 */
export async function recordDrawerOpening(input: {
  shiftId: number;
  openedByUserId: string;
  /** Whose PIN permitted it. Equal to `openedByUserId` when an owner opens it. */
  authorizedByUserId: string;
  reason?: string | null;
}): Promise<{ shiftId: number; recordedAt: string }> {
  return prisma.$transaction(async (tx) => {
    const shift = await tx.cash_shifts.findUnique({
      where: { id: input.shiftId },
      select: { id: true, status: true },
    });
    if (!shift) {
      throw new NotFoundError(`Cash drawer #${input.shiftId}`);
    }
    if (shift.status !== 'open') {
      throw new ConflictError(
        `Cash drawer #${input.shiftId} is closed, so opening it would leave no record to check against`,
        'SHIFT_NOT_OPEN',
      );
    }

    const at = new Date();
    await recordAudit(
      {
        action: 'drawer_open',
        actorUserId: input.openedByUserId,
        authorizedByUserId: input.authorizedByUserId,
        targetType: 'cash_shift',
        targetId: String(shift.id),
        shiftId: shift.id,
        detail: { reason: input.reason?.trim() || null },
      },
      tx,
    );

    return { shiftId: shift.id, recordedAt: at.toISOString() };
  }, TRANSACTION_OPTIONS);
}

/** Closed drawers needing admin review, worst discrepancy first. */
export async function listShiftsNeedingReview(limit = 20): Promise<ShiftSummary[]> {
  const shifts = await prisma.cash_shifts.findMany({
    where: { status: 'closed' },
    orderBy: { closed_at: 'desc' },
    take: limit,
  });

  const summaries = await Promise.all(shifts.map((shift) => summarize(prisma, shift)));
  return summaries
    .filter((shift) => shift.discrepancyKind !== null && shift.discrepancyKind !== 'balanced')
    .sort((a, b) => Math.abs(b.discrepancyThb ?? 0) - Math.abs(a.discrepancyThb ?? 0));
}
