/**
 * Credit notes — reversing a paid sale, with a document behind it.
 *
 * This is the answer to the one question that made this work outrank every
 * feature on the list: a shop that has issued a tax invoice has no compliant way
 * to reverse one otherwise. Receipt numbers here are gapless and never reused,
 * which is correct and also means the *only* honest way to cancel a sale is to
 * leave the invoice alone and issue a second document that points at it. That is
 * what a credit note is, and this module is where one is written.
 *
 * Four decisions are worth stating before the code, because each one closes a
 * failure that a simpler implementation would have:
 *
 *   1. **Full amount only.** One credit note refunds the whole bill and returns
 *      every line. Partial refunds need their own arithmetic across the tax
 *      breakdown and the loyalty ledger, and getting that half-right would put a
 *      wrong figure on a legal document. The schema does not stand in the way —
 *      the figures are snapshotted per document, so a later partial refund is a
 *      change here rather than a migration.
 *   2. **A refunded sale is terminal.** `canTransition(status, 'refund')` is
 *      false for a cancelled order, a live one, and one already refunded — so a
 *      second payout is refused before a transaction is even opened. The
 *      database backs it with a unique index on `credit_notes.order_id`, which
 *      is what survives two requests that both get past the check.
 *   3. **Money leaves through the drawer or by hand, never automatically.**
 *      Pushing money back to a customer's bank needs a PSP relationship and a fee
 *      per transfer, so `cash` is written against the open shift (and refused
 *      when there is none) while `promptpay` is a transfer the cashier already
 *      made in the shop's own app and carries no `shift_id`. The drawer must
 *      reconcile to what actually left it, and nothing else.
 *   4. **Points are best-effort and can never block a refund.** `applyPointChange`
 *      refuses to drive a balance negative, which is right — and would otherwise
 *      mean a customer who spent their points could never return anything. So the
 *      clawback is clamped to the balance and the shortfall is recorded on the
 *      credit note instead of thrown. "We forgave 12 points" is a fact an owner
 *      can act on; a customer held at the counter is not.
 */
import type { credit_notes, orders } from '../generated/prisma/client';

import { recordAudit } from './audit';
import type { RefundMethod, CreditNoteDocument, DocumentLine, RefundSummary } from './credit-note-view';
import { refundMethodLabel } from './credit-note-view';
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { type Db, recordStockMovement, returnRefundedStock } from './inventory';
import { fromDecimal, roundThb } from './money';
import { canTransition } from './order-state';
import { lockOrder } from './orders';
import { applyPointChange } from './points';
import { allocateCreditNoteNumber, loadShop } from './shop';
import { UNCONFIGURED_SHOP } from './shop-view';

/** Matches the sale path: long enough for two registers to queue on one row. */
const TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 30_000 } as const;

/** A refund longer than this is not an explanation, it is a paragraph. */
const MAX_REASON_LENGTH = 500;

/**
 * Refunds a completed sale in full and issues the credit note for it.
 *
 * Everything happens in one transaction, and the order of operations inside it
 * matters:
 *
 *   order row lock → credit-note number (shop row lock) → stock → money → audit
 *
 * The shop row is taken before any product row because every other transaction
 * that touches both — and every sale does, to allocate its receipt number — takes
 * them in that order. Two registers that disagreed about it would deadlock, one
 * holding the shop row while it waits for a product the other holds.
 */
export async function refundOrder(input: {
  orderId: string;
  /** The person at the till. */
  actorId: string;
  reason: string;
  refundMethod: RefundMethod;
  /** The drawer the cash came out of. Required for `cash`, ignored otherwise. */
  shiftId: number | null;
  /** Set when a supervisor's PIN was required. A refund always requires one. */
  authorizedByUserId?: string | null;
}): Promise<RefundSummary> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new ValidationError('A refund needs a reason — it is the only record of why the money left');
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ValidationError(`A refund reason must be at most ${MAX_REASON_LENGTH} characters`);
  }

  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!canTransition(locked.status, 'refund')) {
      throw new ConflictError(
        locked.status === 'refunded'
          ? `Order ${input.orderId} has already been refunded`
          : `Order ${input.orderId} is ${locked.status}; only a completed sale can be refunded`,
        'INVALID_TRANSITION',
      );
    }

    const order = await tx.orders.findUniqueOrThrow({
      where: { id: input.orderId },
      include: {
        items: { include: { product: { select: { name: true } } }, orderBy: { id: 'asc' } },
        payments: { orderBy: { id: 'asc' } },
      },
    });

    /*
     * A cash refund needs a drawer, for the same reason a sale does: money that
     * cannot be reconciled at close is money nobody can account for. Refusing is
     * the honest answer — the alternative is a payout that silently belongs to no
     * shift, which is exactly the hole this application exists to close.
     */
    let shiftId: number | null = null;
    if (input.refundMethod === 'cash') {
      const shift = input.shiftId === null ? null : await tx.cash_shifts.findUnique({
        where: { id: input.shiftId },
      });
      if (!shift || shift.status !== 'open') {
        throw new ConflictError(
          'ไม่มีลิ้นชักที่เปิดอยู่ — เปิดกะก่อนจึงจะคืนเงินสดได้ หรือเลือกโอนคืนผ่านแอปธนาคาร',
          'NO_OPEN_SHIFT',
        );
      }
      shiftId = shift.id;
    }

    const allocation = await allocateCreditNoteNumber(tx, new Date());
    if (allocation === null) {
      throw new ConflictError(
        'This deployment has no shop row, so no credit note can be numbered',
        'SHOP_NOT_CONFIGURED',
      );
    }

    const finalAmount = fromDecimal(order.final_amount);

    /*
     * Points first, so that a failure here is a failure before any stock has
     * moved. The clawback is deliberately clamped rather than attempted: the
     * customer may have spent the points the refund would take back, and their
     * refund must not depend on their balance.
     */
    const earned = order.customer_id ? order.points_earned : 0;
    const redeemed = order.customer_id ? order.points_redeemed : 0;
    let pointsClawedBack = 0;
    let pointsForgiven = 0;

    if (order.customer_id && (earned > 0 || redeemed > 0)) {
      const balance = await pointsBalance(tx, order.customer_id);
      pointsClawedBack = Math.min(earned, Math.max(0, balance));
      pointsForgiven = earned - pointsClawedBack;

      if (pointsClawedBack > 0) {
        await applyPointChange(tx, {
          userId: order.customer_id,
          delta: -pointsClawedBack,
          orderId: order.id,
          description: `ยึดคืนจากใบลดหนี้ ${allocation.documentNumber}`,
        });
      }
      if (redeemed > 0) {
        // Given back unconditionally: the customer paid for that discount with
        // points, and the sale they paid for no longer exists.
        await applyPointChange(tx, {
          userId: order.customer_id,
          delta: redeemed,
          orderId: order.id,
          description: `คืนแต้มจากการคืนสินค้า ${allocation.documentNumber}`,
        });
      }
    }

    const creditNote = await tx.credit_notes.create({
      data: {
        document_number: allocation.documentNumber,
        order_id: order.id,
        shift_id: shiftId,
        reason,
        refund_method: input.refundMethod,
        final_amount: finalAmount,
        /* Copied from the sale's snapshot, not recomputed from today's settings. */
        net_amount: fromDecimal(order.net_amount),
        vat_amount: fromDecimal(order.vat_amount),
        vat_rate_used: order.vat_rate_used,
        points_clawed_back: pointsClawedBack,
        points_forgiven: pointsForgiven,
        created_by: input.actorId,
        authorized_by_user_id: input.authorizedByUserId ?? null,
      },
    });

    let returnedUnits = 0;
    for (const item of order.items) {
      const balanceAfter = await returnRefundedStock(tx, {
        productId: item.product_id,
        qty: item.quantity,
      });
      await recordStockMovement(tx, {
        productId: item.product_id,
        userId: input.actorId,
        movementType: 'pos_refund',
        qtyChanged: item.quantity,
        balanceAfter: balanceAfter.stock_qty,
        note: `คืนสินค้า ${order.order_number} · ${allocation.documentNumber}`,
      });
      returnedUnits += item.quantity;
    }

    /*
     * One leg, for the full amount, in the tender the money actually went back
     * in. Not one leg per original tender: the customer paid ฿107 by card and
     * received ฿107 in notes, and writing a "promptpay refund" that no bank ever
     * performed would put a false line in the one place a shop is obliged to be
     * accurate. What the *sale* was paid with is restated on the credit note as a
     * document fact instead — see `loadCreditNoteDocument`.
     */
    await tx.payments.create({
      data: {
        order_id: order.id,
        shift_id: shiftId,
        method: input.refundMethod,
        amount: finalAmount,
        direction: 'refund',
        credit_note_id: creditNote.id,
      },
    });

    await tx.orders.update({
      where: { id: order.id },
      data: { status: 'refunded' },
    });

    await recordAudit(
      {
        action: 'refund_order',
        actorUserId: input.actorId,
        authorizedByUserId: input.authorizedByUserId ?? null,
        targetType: 'credit_note',
        targetId: allocation.documentNumber,
        shiftId,
        detail: {
          orderNumber: order.order_number,
          documentNumber: allocation.documentNumber,
          reason,
          refundMethod: input.refundMethod,
          finalAmountThb: finalAmount,
          returnedLines: order.items.length,
          returnedUnits,
          pointsClawedBack,
          pointsForgiven,
        },
      },
      tx,
    );

    return {
      orderId: order.id,
      orderNumber: order.order_number,
      status: 'refunded' as const,
      documentNumber: allocation.documentNumber,
      finalAmountThb: finalAmount,
      refundMethod: input.refundMethod,
      returnedLines: order.items.length,
      returnedUnits,
      pointsClawedBack,
      pointsForgiven,
    };
  }, TRANSACTION_OPTIONS);
}

/**
 * The credit note as a printable document, or null when the sale has none.
 *
 * Read back through the order rather than by document number, because that is
 * how every caller reaches it: from a receipt, from the order history, from the
 * till's "พิมพ์ใบลดหนี้" button. The shop's identity comes from the shop as it is
 * *now* — a renamed shop reprints under its new name — while every figure and the
 * document number come from the snapshot, which is the same split the receipt
 * route documents.
 */
export async function loadCreditNoteDocument(orderId: string): Promise<CreditNoteDocument | null> {
  const note = await prisma.credit_notes.findUnique({
    where: { order_id: orderId },
    include: {
      issuer: { select: { full_name: true } },
      approver: { select: { full_name: true } },
      order: {
        include: {
          cashier: { select: { full_name: true } },
          items: { include: { product: { select: { name: true } } }, orderBy: { id: 'asc' } },
          payments: { orderBy: { id: 'asc' } },
        },
      },
    },
  });

  if (!note) {
    return null;
  }

  return toDocument(note);
}

/** The shop identity a credit note prints under, for the document route. */
export async function creditNoteShop() {
  return (await loadShop()) ?? UNCONFIGURED_SHOP;
}

type NoteRow = credit_notes & {
  issuer: { full_name: string };
  approver: { full_name: string } | null;
  order: orders & {
    cashier: { full_name: string } | null;
    items: { quantity: number; unit_price: unknown; total_price: unknown; product: { name: string } }[];
    payments: {
      method: string;
      amount: unknown;
      received_amount: unknown;
      change_amount: unknown;
      direction: string;
    }[];
  };
};

function toDocument(note: NoteRow): CreditNoteDocument {
  const order = note.order;

  /*
   * The sale's own money legs, which are what the customer recognises. Refund
   * legs are filtered out because they belong to this document, not to the sale
   * being reversed.
   */
  const money = order.payments.filter(
    (payment) => payment.method !== 'points' && payment.direction !== 'refund',
  );

  const lines: DocumentLine[] = order.items.map((item) => ({
    name: item.product.name,
    quantity: item.quantity,
    unitPrice: fromDecimal(item.unit_price as never),
    totalPrice: fromDecimal(item.total_price as never),
  }));

  return {
    documentNumber: note.document_number,
    issuedAt: note.created_at.toISOString(),
    reason: note.reason,
    refundMethod: note.refund_method as RefundMethod,
    refundMethodLabel: refundMethodLabel(note.refund_method as RefundMethod),
    finalAmountThb: fromDecimal(note.final_amount),
    netThb: fromDecimal(note.net_amount),
    vatThb: fromDecimal(note.vat_amount),
    vatRatePercent: note.vat_rate_used === null ? null : fromDecimal(note.vat_rate_used),
    isVatInvoice: order.is_vat_invoice,
    pointsClawedBack: note.points_clawed_back,
    pointsForgiven: note.points_forgiven,
    issuedBy: note.issuer.full_name,
    approvedBy: note.approver?.full_name ?? null,
    original: {
      orderNumber: order.order_number,
      receiptNumber: order.receipt_number,
      soldAt: order.created_at.toISOString(),
      soldBy: order.cashier?.full_name ?? null,
      tenders: money.map((payment) => ({
        method: payment.method,
        amountThb: fromDecimal(payment.amount as never),
        receivedThb:
          payment.received_amount === null ? null : fromDecimal(payment.received_amount as never),
      })),
      lines,
      changeThb: money.reduce(
        (largest, payment) => Math.max(largest, fromDecimal(payment.change_amount ?? 0)),
        0,
      ),
    },
  };
}

/**
 * A refunded sale's worth, for the reports that have to show it.
 *
 * Separate from the document because it answers a different question: the
 * document is what the customer holds, this is what the day's takings have to
 * subtract. `null` when the sale was not refunded.
 */
export async function refundedAmountFor(orderId: string): Promise<number | null> {
  const note = await prisma.credit_notes.findUnique({
    where: { order_id: orderId },
    select: { final_amount: true },
  });
  return note ? roundThb(fromDecimal(note.final_amount)) : null;
}

async function pointsBalance(db: Db, userId: string): Promise<number> {
  const user = await db.users.findUnique({
    where: { id: userId },
    select: { points_balance: true },
  });
  return user?.points_balance ?? 0;
}

/** A credit note by its own number — used by the reprint lookup. */
export async function findCreditNoteByNumber(
  documentNumber: string,
): Promise<{ id: string; orderId: string } | null> {
  const note = await prisma.credit_notes.findUnique({
    where: { document_number: documentNumber },
    select: { id: true, order_id: true },
  });
  return note ? { id: note.id, orderId: note.order_id } : null;
}

/** Throws the not-found error a route needs, naming the document. */
export async function requireCreditNoteDocument(orderId: string): Promise<CreditNoteDocument> {
  const document = await loadCreditNoteDocument(orderId);
  if (!document) {
    throw new NotFoundError(`No credit note for order ${orderId}`);
  }
  return document;
}
