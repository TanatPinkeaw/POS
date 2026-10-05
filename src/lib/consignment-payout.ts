/**
 * Paying a consignor what the shop owes them, with a statement (ADR 0023 §6).
 *
 * The ledger already says what is owed; a payout is the act of settling it. That act
 * has three parts, and each is a decision:
 *
 *   * **Money leaves through a door that already exists.** Cash comes out of an open
 *     drawer and carries its `shift_id`, so the close-of-shift count reconciles it; a
 *     transfer is made by hand in the shop's own banking app and touches no drawer, so
 *     it carries none. This is the same rule a cash refund follows (ADR 0004), and the
 *     migration states it as a CHECK rather than trusting each caller.
 *   * **The payout can never exceed the balance.** `assertPayable` refuses it, so the
 *     shop does not hand over money it has not recorded owing. A partial payout is
 *     allowed — the consignor may take part now — and the remainder carries.
 *   * **The debit and its statement are the same transaction.** The
 *     `consignor_payables` row points at the `consignor_payouts` row (`payout_id`), so
 *     the arithmetic and the paper behind it can never be separated, and a rolled-back
 *     payout leaves neither.
 */
import { recordAudit } from './audit';
import { assertPayable, ledgerBalance, payoutEntry } from './consignment-rules';
import type { PayoutMethod } from './consignment-payout-view';
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import type { Db } from './inventory';
import { fromDecimal, roundThb } from './money';

/** Re-exported so a caller gets the method and its labels from one import site. */
export { PAYOUT_METHODS, payoutMethodLabel } from './consignment-payout-view';
export type { PayoutMethod } from './consignment-payout-view';

export interface PayoutInput {
  consignorUserId: string;
  /** How much is being settled. Positive; may be less than the balance. */
  amountThb: number;
  method: PayoutMethod;
  /** The drawer the cash came out of. Required for `cash`, ignored for a transfer. */
  shiftId: number | null;
  /** The signed-in admin handing the money over. */
  actorId: string;
  note?: string | null;
}

export interface PayoutResult {
  payoutId: string;
  consignorUserId: string;
  method: PayoutMethod;
  amountThb: number;
  balanceBeforeThb: number;
  /** The balance after the debit; zero for a full payout, positive for a partial one. */
  balanceAfterThb: number;
  shiftId: number | null;
  createdAt: Date;
}

/**
 * Settles part or all of what the shop owes one consignor.
 *
 * Takes a `Db` so the statement, the ledger debit and the audit row join the caller's
 * transaction: money leaving the shop with the paper behind it undone is exactly the
 * state this design exists to make impossible.
 *
 * Refusals, all before anything is written:
 *
 *   * an unknown method or a non-positive amount (a payout must move money);
 *   * an unknown consignor;
 *   * an amount past the balance (`assertPayable`);
 *   * **cash with no open drawer** — the same refusal a cash refund makes, and for the
 *     same reason: money that cannot be reconciled at close is money nobody can account
 *     for. The transfer path is what a shop without a drawer open should use.
 */
export async function payConsignor(db: Db, input: PayoutInput): Promise<PayoutResult> {
  if (input.method !== 'cash' && input.method !== 'promptpay') {
    throw new ValidationError('วิธีจ่ายเงินไม่ถูกต้อง');
  }
  const amount = roundThb(input.amountThb);

  const consignor = await db.users.findUnique({
    where: { id: input.consignorUserId },
    select: { id: true, role: true },
  });
  if (!consignor) {
    throw new NotFoundError('ไม่พบผู้ใช้ที่ระบุ', `User ${input.consignorUserId}`);
  }

  const balance = await consignorBalance(db, input.consignorUserId);
  assertPayable(balance, amount);

  /*
   * The drawer, checked only for cash — the same shape `refundOrder` uses. A transfer
   * never touches a drawer, so asking it for one would invent a requirement the money
   * does not have.
   */
  let shiftId: number | null = null;
  if (input.method === 'cash') {
    const shift =
      input.shiftId === null ? null : await db.cash_shifts.findUnique({ where: { id: input.shiftId } });
    if (!shift || shift.status !== 'open') {
      throw new ConflictError(
        'ไม่มีลิ้นชักที่เปิดอยู่ — เปิดกะก่อนจึงจะจ่ายเงินสดได้ หรือเลือกโอนผ่านแอปธนาคาร',
        'NO_OPEN_SHIFT',
      );
    }
    shiftId = shift.id;
  }

  const note = input.note?.trim() ? input.note.trim().slice(0, 255) : null;
  const at = new Date();

  const payout = await db.consignor_payouts.create({
    data: {
      consignor_user_id: input.consignorUserId,
      method: input.method,
      amount_thb: amount,
      shift_id: shiftId,
      note,
      created_by: input.actorId,
      created_at: at,
    },
  });

  await db.consignor_payables.create({
    data: {
      consignor_user_id: input.consignorUserId,
      kind: 'payout',
      amount_thb: payoutEntry(amount),
      payout_id: payout.id,
      description: `จ่ายส่วนแบ่งฝากขาย${note ? ` · ${note}` : ''}`,
      created_at: at,
    },
  });

  const balanceAfterThb = roundThb(balance - amount);

  await recordAudit(
    {
      action: 'consignment_paid',
      actorUserId: input.actorId,
      targetType: 'consignor_payout',
      targetId: payout.id.toString(),
      shiftId,
      detail: {
        consignorUserId: input.consignorUserId,
        method: input.method,
        amountThb: amount,
        balanceBeforeThb: balance,
        balanceAfterThb,
        note,
      },
    },
    db,
  );

  return {
    payoutId: payout.id.toString(),
    consignorUserId: input.consignorUserId,
    method: input.method,
    amountThb: amount,
    balanceBeforeThb: balance,
    balanceAfterThb,
    shiftId,
    createdAt: at,
  };
}

/**
 * The balance the shop owes one consignor, to the satang.
 *
 * The ledger's own sum rather than a stored column, so the figure a payout is checked
 * against and the rows that explain it cannot disagree (ADR 0023 §2).
 */
export async function consignorBalance(db: Db, consignorUserId: string): Promise<number> {
  const rows = await db.consignor_payables.findMany({
    where: { consignor_user_id: consignorUserId },
    select: { amount_thb: true },
  });
  return ledgerBalance(rows.map((row) => fromDecimal(row.amount_thb)));
}

export interface ConsignorPosition {
  consignorUserId: string;
  fullName: string;
  phone: string;
  balanceThb: number;
  lastPaidAt: Date | null;
}

/**
 * Every consignor with a ledger, and what they are owed right now.
 *
 * The admin's payout list. Built from the ledger's own group-by so a consignor who has
 * been fully paid still appears (with a zero balance and their last payment date) —
 * the history matters when the next question is "did we already pay them".
 */
export async function listConsignorPositions(db: Db = prisma): Promise<ConsignorPosition[]> {
  const grouped = await db.consignor_payables.groupBy({
    by: ['consignor_user_id'],
    _sum: { amount_thb: true },
  });
  if (grouped.length === 0) {
    return [];
  }

  const ids = grouped.map((row) => row.consignor_user_id);
  const [users, lastPayouts] = await Promise.all([
    db.users.findMany({
      where: { id: { in: ids } },
      select: { id: true, full_name: true, phone: true },
    }),
    db.consignor_payouts.groupBy({
      by: ['consignor_user_id'],
      where: { consignor_user_id: { in: ids } },
      _max: { created_at: true },
    }),
  ]);

  const userById = new Map(users.map((user) => [user.id, user]));
  const lastPaidById = new Map(
    lastPayouts.map((row) => [row.consignor_user_id, row._max.created_at ?? null]),
  );

  return grouped
    .map((row) => {
      const user = userById.get(row.consignor_user_id);
      return {
        consignorUserId: row.consignor_user_id,
        fullName: user?.full_name ?? '—',
        phone: user?.phone ?? '—',
        balanceThb: fromDecimal(row._sum.amount_thb ?? 0),
        lastPaidAt: lastPaidById.get(row.consignor_user_id) ?? null,
      };
    })
    .sort((left, right) => right.balanceThb - left.balanceThb);
}

export interface ConsignorLedgerLine {
  kind: 'sale' | 'refund' | 'payout';
  description: string | null;
  amountThb: number;
  at: Date;
  /** The payout this line is, for a payout line — what a statement hangs off. */
  payoutId: string | null;
}

/** One consignor's whole ledger, oldest first — the detail screen. */
export async function listConsignorLedger(
  consignorUserId: string,
  db: Db = prisma,
): Promise<ConsignorLedgerLine[]> {
  const rows = await db.consignor_payables.findMany({
    where: { consignor_user_id: consignorUserId },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({
    kind: row.kind as ConsignorLedgerLine['kind'],
    description: row.description,
    amountThb: fromDecimal(row.amount_thb),
    at: row.created_at,
    payoutId: row.payout_id?.toString() ?? null,
  }));
}

/** One consignor's current position, or null when the user does not exist. */
export async function getConsignorPosition(
  consignorUserId: string,
  db: Db = prisma,
): Promise<ConsignorPosition | null> {
  const user = await db.users.findUnique({
    where: { id: consignorUserId },
    select: { id: true, full_name: true, phone: true },
  });
  if (!user) {
    return null;
  }
  const [balanceThb, last] = await Promise.all([
    consignorBalance(db, consignorUserId),
    db.consignor_payouts.findFirst({
      where: { consignor_user_id: consignorUserId },
      orderBy: { id: 'desc' },
      select: { created_at: true },
    }),
  ]);
  return {
    consignorUserId,
    fullName: user.full_name,
    phone: user.phone,
    balanceThb,
    lastPaidAt: last?.created_at ?? null,
  };
}

export interface StatementLine {
  kind: 'sale' | 'refund' | 'payout';
  description: string | null;
  /** Signed: a credit is positive, a refund or payout negative. */
  amountThb: number;
  at: Date;
}

export interface PayoutStatement {
  payoutId: string;
  consignorUserId: string;
  consignorName: string;
  method: PayoutMethod;
  amountThb: number;
  shiftId: number | null;
  note: string | null;
  createdAt: Date;
  /**
   * The balance carried into this statement's period: what was left owed after the
   * previous payout, or zero for the first one. Not the balance paid down — the lines
   * below are what moved it, and the amount is what settled them.
   */
  openingBalanceThb: number;
  /** The balance it closed with; zero for a full payout. */
  balanceAfterThb: number;
  /**
   * The movements this payout settles: the credits and debits since the previous
   * payout, oldest first. Every sale it covers, and every refund that clawed one back.
   */
  lines: StatementLine[];
}

/**
 * The statement for one payout, or null when it does not exist.
 *
 * "The sales it covers" is the period between this payout and the previous one: the
 * balance the shop owed at the previous settlement, everything that moved since, and
 * the amount now handed over. That is the honest reading of a partial payout too —
 * the movement list is the open items, not a FIFO wash — and it is the same view for
 * the first payout, whose period starts at the consignor's first movement.
 */
export async function loadPayoutStatement(
  payoutId: string,
  db: Db = prisma,
): Promise<PayoutStatement | null> {
  const id = BigInt(payoutId);
  const payout = await db.consignor_payouts.findUnique({
    where: { id },
    include: { consignor: { select: { full_name: true } } },
  });
  if (!payout) {
    return null;
  }

  const debit = await db.consignor_payables.findFirstOrThrow({ where: { payout_id: id } });
  const previous = await db.consignor_payouts.findFirst({
    where: { consignor_user_id: payout.consignor_user_id, id: { lt: id } },
    orderBy: { id: 'desc' },
  });
  const previousDebit = previous
    ? await db.consignor_payables.findFirst({ where: { payout_id: previous.id } })
    : null;

  const [lines, openingBalanceThb] = await Promise.all([
    db.consignor_payables.findMany({
      where: {
        consignor_user_id: payout.consignor_user_id,
        id: {
          lt: debit.id,
          ...(previousDebit ? { gt: previousDebit.id } : {}),
        },
      },
      orderBy: { id: 'asc' },
    }),
    previousDebit
      ? balanceThrough(db, payout.consignor_user_id, previousDebit.id)
      : Promise.resolve(0),
  ]);

  const linesTotalThb = ledgerBalance(lines.map((line) => fromDecimal(line.amount_thb)));

  return {
    payoutId: payout.id.toString(),
    consignorUserId: payout.consignor_user_id,
    consignorName: payout.consignor.full_name,
    method: payout.method as PayoutMethod,
    amountThb: fromDecimal(payout.amount_thb),
    shiftId: payout.shift_id,
    note: payout.note,
    createdAt: payout.created_at,
    openingBalanceThb,
    balanceAfterThb: roundThb(
      openingBalanceThb + linesTotalThb + fromDecimal(debit.amount_thb),
    ),
    lines: lines.map((line) => ({
      kind: line.kind as StatementLine['kind'],
      description: line.description,
      amountThb: fromDecimal(line.amount_thb),
      at: line.created_at,
    })),
  };
}

/**
 * The ledger's sum up to and including one row — the balance a period opens with,
 * which is what was left owed the moment the previous payout closed.
 */
async function balanceThrough(db: Db, consignorUserId: string, rowId: bigint): Promise<number> {
  const rows = await db.consignor_payables.findMany({
    where: { consignor_user_id: consignorUserId, id: { lte: rowId } },
    select: { amount_thb: true },
  });
  return ledgerBalance(rows.map((row) => fromDecimal(row.amount_thb)));
}

export interface ConsignorPayoutRow {
  payoutId: string;
  method: PayoutMethod;
  amountThb: number;
  createdAt: Date;
  note: string | null;
}

/** A consignor's payment history, newest first, for the statement list. */
export async function listPayoutsFor(
  consignorUserId: string,
  db: Db = prisma,
): Promise<ConsignorPayoutRow[]> {
  const rows = await db.consignor_payouts.findMany({
    where: { consignor_user_id: consignorUserId },
    orderBy: { id: 'desc' },
  });
  return rows.map((row) => ({
    payoutId: row.id.toString(),
    method: row.method as PayoutMethod,
    amountThb: fromDecimal(row.amount_thb),
    createdAt: row.created_at,
    note: row.note,
  }));
}

/** The database client type a caller can hand in, for a transaction. */
export type { Db } from './inventory';
