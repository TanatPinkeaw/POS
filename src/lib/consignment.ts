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
import { NotFoundError, ValidationError } from './errors';
import { adjustStock, type Db } from './inventory';

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

/** Re-exported so a caller can type a `Db` without a second import. */
export type { Db } from './inventory';
