/**
 * The customer's own account, server-side (ADR 0020 §"a customer portal").
 *
 * The portal is the customer's view of facts the shop already holds: their points
 * ledger, their own receipts, and the number that *is* their identity. Nothing here
 * creates a second copy of anything — it reads the ledger, reads the order, and
 * reuses the same access window and payload the walk-in link uses (ADR 0021) — so a
 * portal figure and a printed figure cannot disagree.
 *
 * Every read is scoped by the caller's id, never by a value from the request. That is
 * the whole security property of this module: a member asking for "their" points or
 * "the" receipt gets rows that name *them*, and a receipt that names somebody else is
 * a refusal rather than a 404 that would leak whether the order exists.
 */
import { prisma } from './db';
import { ForbiddenError, NotFoundError } from './errors';
import { loadReceiptPayload, type ReceiptPayload } from './order-view';
import { receiptWithinAccessWindow } from './receipt-access';
import { ReceiptWindowClosedError } from './receipt-link';

/** One row of the points ledger, as the customer reads it. */
export interface PointEntry {
  id: string;
  /** Signed: positive when earned, negative when redeemed. */
  pointsChange: number;
  /** The balance immediately after this row — the ledger's own arithmetic. */
  balanceAfter: number;
  description: string | null;
  /** The order this entry came from, when it came from one. */
  orderId: string | null;
  createdAt: string;
}

export interface PointsPage {
  balance: number;
  entries: PointEntry[];
}

/**
 * How much of the ledger the portal shows.
 *
 * A cap rather than "everything": a customer at a shop for years accumulates rows,
 * and a screen that fetches all of them is a page that gets slower every year. The
 * newest hundred is a window that is honest about being one — the running
 * `balanceAfter` makes the cut visible rather than a silent truncation.
 */
export const POINT_HISTORY_LIMIT = 100;

/**
 * The customer's balance and their recent ledger, newest first.
 *
 * The balance comes from the row, not from summing the entries: the ledger is a
 * record of what happened, the balance is the current truth, and a screen that
 * recomputed it from a *window* of rows would print the wrong number for anybody
 * with more than a hundred transactions.
 */
export async function listCustomerPoints(
  userId: string,
  limit = POINT_HISTORY_LIMIT,
): Promise<PointsPage> {
  const [user, rows] = await Promise.all([
    prisma.users.findUnique({ where: { id: userId }, select: { points_balance: true } }),
    prisma.point_transactions.findMany({
      where: { user_id: userId },
      orderBy: { id: 'desc' },
      take: limit,
    }),
  ]);

  if (!user) {
    throw new NotFoundError(`Customer ${userId}`);
  }

  return {
    balance: user.points_balance,
    entries: rows.map((row) => ({
      id: String(row.id),
      pointsChange: row.points_change,
      balanceAfter: row.balance_after,
      description: row.description,
      orderId: row.order_id,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

/**
 * The receipt for one of the signed-in customer's own orders (ADR 0021 §2).
 *
 * A signed-in customer reading their own receipt does not need a signed link — the
 * session already proves who they are, and minting a credential to read your own
 * document is ceremony. So this reuses `loadReceiptPayload` (the same reading the
 * reprint and the walk-in link share) and applies the **access window** the staff
 * reprint deliberately does not: the month withholds the customer's download, and
 * this is the customer's download.
 *
 * Ownership is a refusal, not a 404. The order may well exist; it is simply not this
 * customer's, and saying so is both truer and no more of a leak than the error the
 * shop already returns for anything else it will not serve.
 */
export async function loadCustomerReceipt(
  orderId: string,
  customerId: string,
): Promise<ReceiptPayload> {
  const order = await prisma.orders.findUnique({
    where: { id: orderId },
    select: { customer_id: true },
  });

  if (!order) {
    throw new NotFoundError(`Order ${orderId}`);
  }
  if (order.customer_id !== customerId) {
    throw new ForbiddenError('ใบเสร็จนี้ไม่ใช่ของบัญชีคุณ');
  }

  const payload = await loadReceiptPayload(orderId);
  if (!receiptWithinAccessWindow(payload.soldAt)) {
    throw new ReceiptWindowClosedError();
  }

  return payload;
}
