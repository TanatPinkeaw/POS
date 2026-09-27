/**
 * Cash drawer (shift) management — SRS §6.2.
 *
 * A shift brackets the cash a till starts with and ends with. Orders settle
 * against an open shift, which is why a walk-in sale cannot complete without
 * one: the payment has to belong to a drawer to be reconcilable.
 */
import type { cash_shifts } from '../generated/prisma/client';

import { prisma } from './db';
import { optionalNumberEnv } from './env';
import { ConflictError, NotFoundError } from './errors';
import { fromDecimal, roundThb } from './money';
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
 * Physical cash taken against a shift.
 *
 * Only `cash` rows count. PromptPay and points never enter the drawer, so
 * folding them in here would invent a discrepancy that does not exist.
 */
async function cashSalesForShift(db: Db, shiftId: number): Promise<number> {
  const rows = await db.$queryRaw<{ total: unknown }[]>`
    SELECT COALESCE(SUM("amount"), 0) AS total
      FROM "payments"
     WHERE "shift_id" = ${shiftId}
       AND "method"   = 'cash'
  `;
  const row = rows[0];
  return row ? Number(row.total) : 0;
}

async function orderCountForShift(db: Db, shiftId: number): Promise<number> {
  const rows = await db.$queryRaw<{ order_count: unknown }[]>`
    SELECT COUNT(DISTINCT "order_id") AS order_count
      FROM "payments"
     WHERE "shift_id" = ${shiftId}
  `;
  const row = rows[0];
  return row ? Number(row.order_count) : 0;
}

/** Projects a raw `cash_shifts` row into the shape the UI consumes. */
async function summarize(db: Db, shift: cash_shifts): Promise<ShiftSummary> {
  const initialCashThb = fromDecimal(shift.initial_cash);
  const cashSalesThb = await cashSalesForShift(db, shift.id);
  const expectedCashThb = computeExpectedCash({ initialCash: initialCashThb, cashSales: cashSalesThb });
  const actualCashThb = shift.actual_cash === null ? null : fromDecimal(shift.actual_cash);

  const discrepancyThb =
    actualCashThb === null
      ? null
      : computeCashDiscrepancy({
          initialCash: initialCashThb,
          cashSales: cashSalesThb,
          actualCash: actualCashThb,
        });

  return {
    id: shift.id,
    status: shift.status,
    openedAt: shift.opened_at,
    closedAt: shift.closed_at,
    initialCashThb,
    cashSalesThb,
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
    const initialCashThb = fromDecimal(existing.initial_cash);
    const cashSalesThb = await cashSalesForShift(tx, input.shiftId);
    const expectedCashThb = computeExpectedCash({
      initialCash: initialCashThb,
      cashSales: cashSalesThb,
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
