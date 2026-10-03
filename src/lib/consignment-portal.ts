/**
 * What a consignor is owed, read from the customer's own portal (ADR 0023, ADR 0020).
 *
 * Seeing their own money is what keeps a consignment arrangement out of dispute: the
 * member left goods with the shop and the shop sells them, so "how much have I earned"
 * must be answerable from the member's own account, not from a phone call to the owner.
 * This module is that answer, built from the same rows the admin's payout screen reads
 * (the `consignor_payables` ledger and the products consigned to them), so a figure the
 * customer sees and a figure the owner pays against cannot disagree.
 *
 * Every read is scoped by the caller's id, never by a value from the request. That is
 * the whole security property: a member asking for "their" consignment gets the rows
 * that name *them*, so one phone number can never see another consignor's balance. The
 * scoping lives here rather than in the route for the same reason it does in
 * `customer-portal.ts` — the query that reads the data is the query that enforces it.
 */
import { consignorBalance } from './consignment-payout';
import { prisma } from './db';
import type { Db } from './inventory';
import { fromDecimal, roundThb } from './money';

/** One consigned product, as the member reads it. */
export interface CustomerConsignmentItem {
  productId: string;
  name: string;
  /** The agreed share of the net, excluding VAT (ADR 0023 §4). */
  sharePercent: number;
  /** What the shop still holds of theirs, on the shelf right now. */
  onHandQty: number;
  /** Units sold across completed orders. */
  soldQty: number;
  /** Units a refund has taken back, which clawed the share back with them. */
  refundedQty: number;
  /** The net this product has credited them: sales minus their refunds. */
  earnedThb: number;
}

/** One movement in the member's own ledger. */
export interface CustomerConsignmentEntry {
  id: string;
  kind: 'sale' | 'refund' | 'payout';
  description: string | null;
  /** Signed: a sale credits, a refund or payout debits. */
  amountThb: number;
  at: string;
  /** The settlement this line is, for a payout — the statement it belongs to. */
  payoutId: string | null;
}

export interface CustomerConsignment {
  /** What the shop owes right now. May be negative if a payout outpaced a refund. */
  balanceThb: number;
  /** The goods they have left with the shop, newest consignment first. */
  items: CustomerConsignmentItem[];
  /** Every movement, newest first — a payout reads as a settled statement. */
  entries: CustomerConsignmentEntry[];
}

/**
 * How much of the ledger the portal shows. The same cap the points panel uses: a
 * consignor trading for years accumulates rows, and a screen that fetches all of them
 * gets slower every year. The newest hundred is a window honest about being one.
 */
export const CONSIGNMENT_HISTORY_LIMIT = 100;

/**
 * The signed-in member's consignment position: how much is owed, what they have left
 * with the shop (and how much of it has sold), and every movement on the ledger.
 *
 * Nothing is computed that the database already holds. The balance is the ledger's own
 * sum, so it equals the figure the admin's payout screen checks against; the sold and
 * refunded quantities are read from the order and credit-note rows rather than from a
 * counter that could drift.
 */
export async function loadCustomerConsignment(
  customerId: string,
  db: Db = prisma,
  limit = CONSIGNMENT_HISTORY_LIMIT,
): Promise<CustomerConsignment> {
  const [products, ledgerRows, balanceThb] = await Promise.all([
    db.products.findMany({
      where: { consignor_user_id: customerId },
      select: { id: true, name: true, stock_qty: true, consignor_share_percent: true },
      orderBy: { created_at: 'desc' },
    }),
    db.consignor_payables.findMany({
      where: { consignor_user_id: customerId },
      orderBy: { id: 'desc' },
      take: limit,
    }),
    // The *whole* ledger, not the window above: the balance is a fact about every row,
    // and the same `consignorBalance` the admin's payout screen checks against, so the
    // number the member reads and the number the owner pays cannot differ.
    consignorBalance(db, customerId),
  ]);

  const productIds = products.map((product) => product.id);

  const [soldRows, refundedRows, earnedRows] = await Promise.all([
    productIds.length === 0
      ? Promise.resolve([])
      : db.order_items.findMany({
          where: { product_id: { in: productIds }, order: { status: 'completed' } },
          select: { product_id: true, quantity: true },
        }),
    productIds.length === 0
      ? Promise.resolve([])
      : db.credit_note_items.findMany({
          where: { order_item: { product_id: { in: productIds } } },
          select: { quantity: true, order_item: { select: { product_id: true } } },
        }),
    productIds.length === 0
      ? Promise.resolve([])
      : db.consignor_payables.findMany({
          where: { consignor_user_id: customerId, product_id: { in: productIds } },
          select: { product_id: true, amount_thb: true },
        }),
  ]);

  const soldByProduct = new Map<string, number>();
  for (const row of soldRows) {
    soldByProduct.set(row.product_id, (soldByProduct.get(row.product_id) ?? 0) + row.quantity);
  }

  const refundedByProduct = new Map<string, number>();
  for (const row of refundedRows) {
    const productId = row.order_item.product_id;
    refundedByProduct.set(productId, (refundedByProduct.get(productId) ?? 0) + row.quantity);
  }

  const earnedByProduct = new Map<string, number>();
  for (const row of earnedRows) {
    const productId = row.product_id;
    if (!productId) {
      continue;
    }
    earnedByProduct.set(
      productId,
      roundThb((earnedByProduct.get(productId) ?? 0) + fromDecimal(row.amount_thb)),
    );
  }

  return {
    balanceThb,
    items: products.map((product) => ({
      productId: product.id,
      name: product.name,
      sharePercent: product.consignor_share_percent ?? 0,
      onHandQty: product.stock_qty,
      soldQty: soldByProduct.get(product.id) ?? 0,
      refundedQty: refundedByProduct.get(product.id) ?? 0,
      earnedThb: earnedByProduct.get(product.id) ?? 0,
    })),
    entries: ledgerRows.map((row) => ({
      id: row.id.toString(),
      kind: row.kind as CustomerConsignmentEntry['kind'],
      description: row.description,
      amountThb: fromDecimal(row.amount_thb),
      at: row.created_at.toISOString(),
      payoutId: row.payout_id?.toString() ?? null,
    })),
  };
}
