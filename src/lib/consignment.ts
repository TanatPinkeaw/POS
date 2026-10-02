/**
 * Setting up consignment, and taking the goods back (ADR 0023 §1, §2).
 *
 * A consigned product is one the shop sells but does not own: it belongs to exactly
 * one member, and the shop owes that member an agreed share of the net on every
 * sale. That makes two ordinary actions — marking a product and adjusting its
 * stock — into ones with a liability behind them, so both leave a trail:
 *
 *   * putting a product into consignment (or re-agreeing the share) writes an
 *     `consignment_set` row carrying the consignor, the percent, and what they were
 *     before, because a share is renegotiated far more often than it is first set;
 *   * taking unsold goods back moves the stock (SRS §4.3, `stock_logs`) *and* writes
 *     `consignment_withdrawn`, because the shelf really changed and so did who owns it.
 *
 * **A product that has been sold keeps its owner.** The share is a property of the
 * product, and the two write sites (ticket 04) read it at the moment of sale; letting
 * a sold product change hands would make "who did we owe for that line" a question
 * with two answers. The percent, by contrast, *may* be re-agreed after a sale — the
 * terms are a bargain, not a fact — and that is exactly what the audit row is for.
 *
 * Both functions take a `Db` so their writes join the caller's transaction: an audit
 * row that survives a rollback would describe something the database undid.
 */
import type { Prisma } from '../generated/prisma/client';

import { recordAudit } from './audit';
import { clawbackFromLine, lineNetExclVat, refundReversal, shareFromSale } from './consignment-rules';
import { NotFoundError, ValidationError } from './errors';
import { adjustStock, type Db } from './inventory';
import { fromDecimal } from './money';

export interface ConsignmentTerms {
  productId: string;
  /** The member the goods belong to. Must already be a `member`. */
  consignorUserId: string;
  /** The agreed share of the net, 0–100. */
  sharePercent: number;
  /** The signed-in admin making the change. */
  actorId: string;
}

export interface ConsignmentResult {
  productId: string;
  consignorUserId: string;
  sharePercent: number;
}

/**
 * Puts a product into consignment, or changes the member and share it already has.
 *
 * A new consignor must be an existing `member` — the shop cannot owe a share to a
 * staff account or to an id that does not exist. Changing the owner of a product that
 * has any order line behind it is refused; changing only the percent is allowed and
 * audited with the old value.
 */
export async function setConsignment(
  db: Db,
  input: ConsignmentTerms,
): Promise<ConsignmentResult> {
  const product = await db.products.findUnique({
    where: { id: input.productId },
    select: {
      id: true,
      consignor_user_id: true,
      consignor_share_percent: true,
    },
  });
  if (!product) {
    throw new NotFoundError(`Product ${input.productId}`);
  }

  const consignor = await db.users.findUnique({
    where: { id: input.consignorUserId },
    select: { id: true, role: true },
  });
  if (!consignor || consignor.role !== 'member') {
    throw new ValidationError('ผู้รับฝากขายต้องเป็นสมาชิก (member) เท่านั้น');
  }

  const ownerChanging = product.consignor_user_id !== input.consignorUserId;
  if (ownerChanging) {
    const soldLines = await db.order_items.count({ where: { product_id: input.productId } });
    if (soldLines > 0) {
      throw new ValidationError('สินค้าที่เคยขายหรือถูกจองแล้ว เปลี่ยนเจ้าของไม่ได้');
    }
  }

  await db.products.update({
    where: { id: input.productId },
    data: {
      consignor_user_id: input.consignorUserId,
      consignor_share_percent: input.sharePercent,
    },
  });

  await recordAudit(
    {
      action: 'consignment_set',
      actorUserId: input.actorId,
      targetType: 'product',
      targetId: input.productId,
      detail: {
        consignorUserId: input.consignorUserId,
        sharePercent: input.sharePercent,
        previousConsignorUserId: product.consignor_user_id,
        previousSharePercent: product.consignor_share_percent,
      },
    },
    db,
  );

  return {
    productId: input.productId,
    consignorUserId: input.consignorUserId,
    sharePercent: input.sharePercent,
  };
}

export interface WithdrawalInput {
  productId: string;
  actorId: string;
  note?: string | null;
}

export interface WithdrawalResult {
  productId: string;
  /** The member whose goods came back. */
  consignorUserId: string;
  /** How many units physically left the shelf. */
  withdrawnQty: number;
  /** Stock left after the withdrawal — always zero, absent a concurrent sale. */
  stockQty: number;
}

/**
 * Takes a consignor's unsold goods back and ends the shop's liability for them.
 *
 * The physical stock is only removed **if there is any**: a product whose shelf is
 * already empty has nothing to withdraw, and an adjustment of zero is not a movement
 * the SRS would accept. Otherwise the units leave through `adjustStock`, so the shelf
 * change is a §4.3 row with a reason rather than a silent edit.
 *
 * Refused for a product that has been sold — the goods are the customer's, not the
 * consignor's, and the shop still owes the share on them.
 */
export async function withdrawConsignment(
  db: Db,
  input: WithdrawalInput,
): Promise<WithdrawalResult> {
  const product = await db.products.findUnique({
    where: { id: input.productId },
    select: {
      id: true,
      consignor_user_id: true,
      consignor_share_percent: true,
      stock_qty: true,
    },
  });
  if (!product) {
    throw new NotFoundError(`Product ${input.productId}`);
  }
  if (!product.consignor_user_id) {
    throw new ValidationError('สินค้านี้ไม่ได้อยู่ในระบบฝากขาย');
  }

  const soldLines = await db.order_items.count({ where: { product_id: input.productId } });
  if (soldLines > 0) {
    throw new ValidationError('สินค้าที่เคยขายแล้ว ถอนฝากขายไม่ได้');
  }

  let withdrawnQty = 0;
  let stockQty = product.stock_qty;
  if (product.stock_qty > 0) {
    const { balance } = await adjustStock(db, {
      productId: input.productId,
      delta: -product.stock_qty,
      reason: 'REASON_CORRECTION',
      note: input.note?.trim() || 'ถอนสินค้าฝากขาย',
      userId: input.actorId,
    });
    withdrawnQty = product.stock_qty;
    stockQty = balance.stock_qty;
  }

  await db.products.update({
    where: { id: input.productId },
    data: { consignor_user_id: null, consignor_share_percent: null },
  });

  await recordAudit(
    {
      action: 'consignment_withdrawn',
      actorUserId: input.actorId,
      targetType: 'product',
      targetId: input.productId,
      detail: {
        consignorUserId: product.consignor_user_id,
        sharePercent: product.consignor_share_percent,
        withdrawnQty,
      },
    },
    db,
  );

  return {
    productId: input.productId,
    consignorUserId: product.consignor_user_id,
    withdrawnQty,
    stockQty,
  };
}

export interface RecordShareInput {
  orderId: string;
  /** The instant the sale committed, reused as `created_at` so the ledger and the
   *  order's own books cannot disagree about which day a sale is in. */
  at: Date;
}

/**
 * Writes one payable credit per consigned line of a sale that has just been written
 * (ADR 0023 §5).
 *
 * Called from inside each sale's own transaction — the walk-in bill and the pre-order
 * handover are the only two places a sale completes — and reads the order it is given
 * rather than any cart, so the figures come from the rows that are about to commit.
 * That is what makes a rolled-back sale owe nobody: the credit is written in the same
 * transaction as the money, so if the money is undone the credit is undone with it.
 *
 * The order is read through the transaction (there is no `include`), and its own
 * `net_amount` — the taxable base after any discount, snapshotted by `resolveSaleTax` —
 * is split across the lines by `lineNetExclVat`, so a consigned line's share is a
 * percentage of what that line actually contributed, not of its shelf price. VAT is
 * excluded because it belongs to the state (ADR 0023 §4).
 *
 * A product with no consignor is skipped, which is the ordinary case; the loop exists
 * for the one line in the cart that is somebody else's. A credit is written even when
 * the share rounds to zero — a zero row is a record that the line sold, and dropping it
 * would leave the consignor's statement with a gap where a sale was.
 */
export async function recordConsignorShares(db: Db, input: RecordShareInput): Promise<number> {
  const order = await db.orders.findUniqueOrThrow({
    where: { id: input.orderId },
    select: { order_number: true, net_amount: true, subtotal_amount: true },
  });

  const items = await db.order_items.findMany({
    where: { order_id: input.orderId },
    select: {
      id: true,
      product_id: true,
      total_price: true,
      product: { select: { consignor_user_id: true, consignor_share_percent: true } },
    },
    orderBy: { id: 'asc' },
  });

  const netAmount = fromDecimal(order.net_amount);
  const subtotal = fromDecimal(order.subtotal_amount);

  let written = 0;
  for (const item of items) {
    const consignorUserId = item.product.consignor_user_id;
    const percent = item.product.consignor_share_percent;
    if (!consignorUserId || percent === null) {
      continue;
    }

    const lineNet = lineNetExclVat(netAmount, fromDecimal(item.total_price), subtotal);
    const amount = shareFromSale(lineNet, percent);

    await db.consignor_payables.create({
      data: {
        consignor_user_id: consignorUserId,
        kind: 'sale',
        amount_thb: amount,
        order_id: input.orderId,
        order_item_id: item.id,
        product_id: item.product_id,
        description: `ส่วนแบ่งฝากขายจากบิล ${order.order_number}`,
        created_at: input.at,
      },
    });
    written += 1;
  }

  return written;
}

export interface RefundedConsignmentLine {
  /** The sale line that sold, which is what the refund names. */
  orderItemId: string;
  /** How many units this refund takes back. */
  quantity: number;
  /**
   * True when this refund leaves none of the line outstanding. Passed in rather than
   * re-derived: the refund already knows the sale's quantity, what earlier notes took,
   * and what this one does, and asking the database the same question twice is how two
   * answers to "is it closed" start to differ.
   */
  closesLine: boolean;
}

export interface RecordRefundsInput {
  orderId: string;
  /** The instant the refund committed, reused as `created_at` so the ledger and the
   *  credit note cannot disagree about which day a reversal is in. */
  at: Date;
  /** The lines this refund takes back, from the refund plan. */
  lines: RefundedConsignmentLine[];
}

/**
 * Writes one payable debit per consigned line a refund takes back (ADR 0023 §6).
 *
 * The goods go back to the consignor, so the share goes back with them. Called from
 * inside the refund's own transaction — `refundOrder` is the only place a sale is
 * reversed — so a rolled-back refund claws nothing back, for the same reason a
 * rolled-back sale owes nobody (ticket 04).
 *
 * The debit is **not** recomputed from the refund's money: it is the share the sale
 * credited, read back off its own `sale` row for the line and split by units. That
 * matters when the terms were re-agreed after the sale — the balance is a sum of
 * what was written, and a clawback that recomputed at today's percent would take back
 * a number the shop never owed. A line with no `sale` row was not consigned (or was
 * sold before the ledger existed), so there is nothing to reverse and it is skipped.
 *
 * Nothing here checks the resulting balance. A payout already taken can leave the
 * balance negative, and the debit still has to be written — the next payout nets
 * against it (ADR 0023 §6), exactly as a `points_forgiven` shortfall is carried.
 */
export async function recordConsignorRefunds(
  db: Db,
  input: RecordRefundsInput,
): Promise<number> {
  if (input.lines.length === 0) {
    return 0;
  }

  const order = await db.orders.findUniqueOrThrow({
    where: { id: input.orderId },
    select: { order_number: true },
  });

  const itemIds = input.lines.map((line) => BigInt(line.orderItemId));

  const items = await db.order_items.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, quantity: true },
  });
  const lineQtyByItem = new Map(items.map((item) => [item.id.toString(), item.quantity]));

  /*
   * What the sale credited each line, and who was credited: the row is the record of
   * the debt, so it is also the record of who is owed it back.
   */
  const credits = await db.consignor_payables.findMany({
    where: { order_id: input.orderId, kind: 'sale', order_item_id: { in: itemIds } },
    select: {
      order_item_id: true,
      consignor_user_id: true,
      product_id: true,
      amount_thb: true,
    },
  });
  const creditedByItem = new Map<
    string,
    { amount: number; consignorUserId: string; productId: string | null }
  >();
  for (const row of credits) {
    const key = row.order_item_id!.toString();
    const current = creditedByItem.get(key);
    creditedByItem.set(key, {
      amount: (current?.amount ?? 0) + fromDecimal(row.amount_thb),
      consignorUserId: row.consignor_user_id,
      productId: row.product_id,
    });
  }

  /* What earlier notes already clawed back for each line, as a magnitude to subtract. */
  const reversals = await db.consignor_payables.findMany({
    where: { order_id: input.orderId, kind: 'refund', order_item_id: { in: itemIds } },
    select: { order_item_id: true, amount_thb: true },
  });
  const reversedByItem = new Map<string, number>();
  for (const row of reversals) {
    const key = row.order_item_id!.toString();
    reversedByItem.set(key, (reversedByItem.get(key) ?? 0) + Math.abs(fromDecimal(row.amount_thb)));
  }

  let written = 0;
  for (const line of input.lines) {
    const credit = creditedByItem.get(line.orderItemId);
    if (!credit) {
      continue;
    }

    const lineQty = lineQtyByItem.get(line.orderItemId);
    if (lineQty === undefined) {
      continue;
    }

    const amount = clawbackFromLine(
      credit.amount,
      reversedByItem.get(line.orderItemId) ?? 0,
      line.quantity,
      lineQty,
      line.closesLine,
    );

    await db.consignor_payables.create({
      data: {
        consignor_user_id: credit.consignorUserId,
        kind: 'refund',
        amount_thb: refundReversal(amount),
        order_id: input.orderId,
        order_item_id: BigInt(line.orderItemId),
        product_id: credit.productId,
        description: `คืนส่วนแบ่งฝากขายจากบิล ${order.order_number}`,
        created_at: input.at,
      },
    });
    written += 1;
  }

  return written;
}

/** Re-exported so a caller can type a `Db` without a second import. */
export type { Db } from './inventory';
