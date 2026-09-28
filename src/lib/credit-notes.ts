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
 *   1. **A bill can be refunded in pieces, and the pieces add up.** Each note
 *      itemises the lines and quantities it takes back, and the *arithmetic* lives
 *      in `refund-plan.ts` where it is pure and tested: every note but the last
 *      rounds its share of the order-level discount, and the note that empties the
 *      sale takes the remainder instead of computing its own. That one rule is
 *      what stops a split refund leaving a satang stranded — the failure mode of
 *      `refund / 3` written three times.
 *   2. **The sale itself is never rewritten.** The order's totals stay exactly as
 *      the invoice printed them, and what has been refunded is the sum of its
 *      notes. The order's *status* moves to `refunded` only when the last
 *      refundable unit is gone, which is what keeps `canTransition` a complete
 *      answer to "can this be refunded again" without inventing a status per
 *      degree of refundedness.
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
 *      can act on; a customer held at the counter is not. On a partial refund the
 *      clawback is that note's share of what was earned, and the closing note takes
 *      the remainder — so points come back exactly once, however many visits it
 *      takes. Redeemed points are returned only when the bill is fully reversed:
 *      the discount they paid for applied to the whole purchase, and giving a third
 *      of it back would leave the customer holding a discount for goods they kept.
 */
import type { credit_notes, orders } from '../generated/prisma/client';

import { recordAudit } from './audit';
import type { RefundMethod, CreditNoteDocument, DocumentLine, RefundSummary } from './credit-note-view';
import { refundMethodLabel } from './credit-note-view';
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { type Db, recordStockMovement, returnRefundedStock } from './inventory';
import { fromDecimal, roundThb, sumThb, toSatang } from './money';
import { canTransition } from './order-state';
import { lockOrder } from './orders';
import { applyPointChange } from './points';
import { planRefund, refundTax, type RefundableLine, type RefundRequestLine } from './refund-plan';
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
  /**
   * The lines to take back. Omitted or null means everything still outstanding,
   * which is what a full refund is and what the till sends when the cashier does
   * not pick lines apart.
   */
  lines?: RefundRequestLine[] | null;
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
        /*
         * Every note already on this bill, with what each one took back. Read
         * inside the transaction that holds the order's row lock, so two cahsiers
         * refunding the same line at two tills cannot both see it as outstanding —
         * the second waits on the lock and then finds the units already gone.
         */
        credit_notes: {
          orderBy: { sequence: 'asc' },
          include: { items: { select: { order_item_id: true, quantity: true } } },
        },
      },
    });

    /*
     * A line that was sold and has come back in part is still refundable — three
     * units sold, one back on Monday, two on Friday — so the plan is given the
     * running total per line rather than a flag.
     */
    const returnedByItem = new Map<string, number>();
    for (const note of order.credit_notes) {
      for (const line of note.items) {
        const key = line.order_item_id.toString();
        returnedByItem.set(key, (returnedByItem.get(key) ?? 0) + line.quantity);
      }
    }

    const refundable: RefundableLine[] = order.items.map((item) => ({
      orderItemId: item.id.toString(),
      name: item.product.name,
      quantity: item.quantity,
      returnedQuantity: returnedByItem.get(item.id.toString()) ?? 0,
      totalPrice: fromDecimal(item.total_price),
    }));

    const plan = planRefund({
      lines: refundable,
      requested: input.lines ?? null,
      subtotalThb: fromDecimal(order.subtotal_amount),
      discountThb: fromDecimal(order.discount_amount),
      finalAmountThb: fromDecimal(order.final_amount),
      alreadyRefundedThb: sumThb(order.credit_notes.map((note) => fromDecimal(note.final_amount))),
    });

    const finalAmount = plan.refundThb;

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

    /*
     * Points first, so that a failure here is a failure before any stock has
     * moved. The clawback is deliberately clamped rather than attempted: the
     * customer may have spent the points the refund would take back, and their
     * refund must not depend on their balance.
     */
    const earned = order.customer_id ? order.points_earned : 0;
    const redeemed = order.customer_id ? order.points_redeemed : 0;
    const alreadyClawedBack = order.credit_notes.reduce(
      (total, note) => total + note.points_clawed_back,
      0,
    );

    /*
     * This note's share of the points the sale awarded. The closing note takes what
     * is left rather than its own share, for the same reason the money works that
     * way: three rounded shares do not add back up.
     */
    const clawbackTarget = plan.closes
      ? Math.max(0, earned - alreadyClawedBack)
      : Math.floor((earned * toSatang(finalAmount)) / Math.max(1, toSatang(fromDecimal(order.final_amount))));

    /*
     * Given back only when the bill is fully reversed, because the discount those
     * points bought applied to the whole purchase. Returning a third of them would
     * leave the customer holding a discount for goods they kept.
     */
    const redeemReturn = plan.closes ? redeemed : 0;

    let pointsClawedBack = 0;
    let pointsForgiven = 0;

    if (order.customer_id && (clawbackTarget > 0 || redeemReturn > 0)) {
      const balance = await pointsBalance(tx, order.customer_id);

      if (clawbackTarget > 0) {
        /*
         * Clamped rather than attempted: the customer may already have spent the
         * points, and their refund cannot depend on their balance. The shortfall is
         * recorded on the document instead of thrown.
         */
        pointsClawedBack = Math.min(clawbackTarget, Math.max(0, balance));
        pointsForgiven = clawbackTarget - pointsClawedBack;

        if (pointsClawedBack > 0) {
          await applyPointChange(tx, {
            userId: order.customer_id,
            delta: -pointsClawedBack,
            orderId: order.id,
            description: `ยึดคืนจากใบลดหนี้ ${allocation.documentNumber}`,
          });
        }
      }

      if (redeemReturn > 0) {
        await applyPointChange(tx, {
          userId: order.customer_id,
          delta: redeemReturn,
          orderId: order.id,
          description: `คืนแต้มจากการคืนสินค้า ${allocation.documentNumber}`,
        });
      }
    }

    /*
     * The tax, out of the sale's own snapshot rather than today's settings — and on
     * the closing note, the base the earlier notes did not claim, so the notes
     * reconstruct the invoice's net and VAT exactly.
     */
    const tax = refundTax({
      refundThb: finalAmount,
      ratePercent: order.vat_rate_used === null ? 0 : fromDecimal(order.vat_rate_used),
      isVatInvoice: order.is_vat_invoice,
      netOverride: plan.closes
        ? fromDecimal(order.net_amount) -
          sumThb(order.credit_notes.map((note) => fromDecimal(note.net_amount)))
        : null,
    });

    const nextSequence =
      order.credit_notes.reduce((highest, note) => Math.max(highest, note.sequence), 0) + 1;

    const creditNote = await tx.credit_notes.create({
      data: {
        document_number: allocation.documentNumber,
        order_id: order.id,
        sequence: nextSequence,
        shift_id: shiftId,
        reason,
        refund_method: input.refundMethod,
        gross_amount: plan.grossThb,
        discount_amount: plan.discountThb,
        final_amount: finalAmount,
        net_amount: tax.netThb,
        vat_amount: tax.vatThb,
        vat_rate_used: order.vat_rate_used,
        points_clawed_back: pointsClawedBack,
        points_forgiven: pointsForgiven,
        created_by: input.actorId,
        authorized_by_user_id: input.authorizedByUserId ?? null,
      },
    });

    const itemsById = new Map(order.items.map((item) => [item.id.toString(), item]));
    let returnedUnits = 0;

    for (const line of plan.lines) {
      const item = itemsById.get(line.orderItemId);
      if (!item) {
        throw new ConflictError(
          `Order item ${line.orderItemId} vanished while the refund was being written`,
          'ORDER_ITEM_MISSING',
        );
      }

      await tx.credit_note_items.create({
        data: {
          credit_note_id: creditNote.id,
          order_item_id: item.id,
          quantity: line.quantity,
          unit_price: line.unitPrice,
          line_total: line.lineTotal,
        },
      });

      const balanceAfter = await returnRefundedStock(tx, {
        productId: item.product_id,
        qty: line.quantity,
      });
      await recordStockMovement(tx, {
        productId: item.product_id,
        userId: input.actorId,
        movementType: 'pos_refund',
        qtyChanged: line.quantity,
        balanceAfter: balanceAfter.stock_qty,
        note: `คืนสินค้า ${order.order_number} · ${allocation.documentNumber}`,
      });
      returnedUnits += line.quantity;
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

    /*
     * The status moves only when there is nothing left to refund. A partly credited
     * bill is still a completed sale — it is the *notes* that record what came back,
     * and `canTransition` keeps being a complete answer to "can this be refunded
     * again" without a status per degree of refundedness.
     */
    if (plan.closes) {
      await tx.orders.update({
        where: { id: order.id },
        data: { status: 'refunded' },
      });
    }

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
          sequence: nextSequence,
          /*
           * Whether this note finished the sale is the first thing an owner
           * scanning the trail for "where did the money go" needs to know: a
           * partial refund leaves a bill that was still paid.
           */
          partial: !plan.closes,
          reason,
          refundMethod: input.refundMethod,
          grossAmountThb: plan.grossThb,
          discountThb: plan.discountThb,
          finalAmountThb: finalAmount,
          returnedLines: plan.lines.length,
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
      /* The sale's status, which is unchanged by a partial refund. */
      status: plan.closes ? ('refunded' as const) : ('completed' as const),
      sequence: nextSequence,
      partial: !plan.closes,
      documentNumber: allocation.documentNumber,
      grossAmountThb: plan.grossThb,
      discountThb: plan.discountThb,
      finalAmountThb: finalAmount,
      refundMethod: input.refundMethod,
      returnedLines: plan.lines.length,
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
 *
 * A sale can carry several notes now, so `documentNumber` picks one and omitting it
 * means "the latest" — which is what a till reprinting straight after a refund
 * wants, and what an order screen shows when it can only show one.
 */
export async function loadCreditNoteDocument(
  orderId: string,
  documentNumber?: string | null,
): Promise<CreditNoteDocument | null> {
  const note = await prisma.credit_notes.findFirst({
    where: {
      order_id: orderId,
      ...(documentNumber ? { document_number: documentNumber } : {}),
    },
    orderBy: { sequence: 'desc' },
    include: {
      items: { orderBy: { id: 'asc' } },
      issuer: { select: { full_name: true } },
      approver: { select: { full_name: true } },
      order: {
        include: {
          cashier: { select: { full_name: true } },
          items: { include: { product: { select: { name: true } } }, orderBy: { id: 'asc' } },
          payments: { orderBy: { id: 'asc' } },
          /* The siblings, for "did this note finish the sale" — see `toDocument`. */
          credit_notes: { select: { sequence: true, final_amount: true } },
        },
      },
    },
  });

  if (!note) {
    return null;
  }

  return toDocument(note);
}

/**
 * Every credit note on a sale, newest first.
 * What an order screen needs to show that a bill was refunded in pieces rather than
 * hiding all but the last document.
 */
export async function listCreditNoteDocuments(orderId: string): Promise<CreditNoteDocument[]> {
  const notes = await prisma.credit_notes.findMany({
    where: { order_id: orderId },
    orderBy: { sequence: 'desc' },
    include: {
      items: { orderBy: { id: 'asc' } },
      issuer: { select: { full_name: true } },
      approver: { select: { full_name: true } },
      order: {
        include: {
          cashier: { select: { full_name: true } },
          items: { include: { product: { select: { name: true } } }, orderBy: { id: 'asc' } },
          payments: { orderBy: { id: 'asc' } },
          credit_notes: { select: { sequence: true, final_amount: true } },
        },
      },
    },
  });

  return notes.map(toDocument);
}

/** The shop identity a credit note prints under, for the document route. */
export async function creditNoteShop() {
  return (await loadShop()) ?? UNCONFIGURED_SHOP;
}

type NoteRow = credit_notes & {
  items: { order_item_id: bigint; quantity: number; unit_price: unknown; line_total: unknown }[];
  issuer: { full_name: string };
  approver: { full_name: string } | null;
  order: orders & {
    cashier: { full_name: string } | null;
    items: {
      id: bigint;
      quantity: number;
      unit_price: unknown;
      total_price: unknown;
      product: { name: string };
    }[];
    payments: {
      method: string;
      amount: unknown;
      received_amount: unknown;
      change_amount: unknown;
      direction: string;
    }[];
    credit_notes: { sequence: number; final_amount: unknown }[];
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

  /*
   * The lines *this note* takes back, joined to the sale's own lines for their
   * names. A note written before this column existed has no item rows and falls
   * back to the whole invoice, which is exactly what it reversed.
   */
  const byItemId = new Map(order.items.map((item) => [item.id.toString(), item]));
  const returned: DocumentLine[] =
    note.items.length === 0
      ? lines
      : note.items.map((line) => {
          const item = byItemId.get(line.order_item_id.toString());
          return {
            name: item?.product.name ?? 'สินค้า',
            quantity: line.quantity,
            unitPrice: fromDecimal(line.unit_price as never),
            totalPrice: fromDecimal(line.line_total as never),
          };
        });

  /*
   * Whether this note left the sale standing. Asked of the whole set of notes rather
   * than stored on each one: the closing note is the last one written *and* the one
   * that made the notes add up to the invoice, so a reprint answers the question
   * from the same evidence a person would use.
   */
  const siblings = order.credit_notes;
  const coveredByNotes = sumThb(
    siblings.map((sibling) => fromDecimal(sibling.final_amount as never)),
  );
  const isClosing =
    note.sequence === Math.max(...siblings.map((sibling) => sibling.sequence)) &&
    coveredByNotes >= fromDecimal(order.final_amount);

  return {
    documentNumber: note.document_number,
    sequence: note.sequence,
    isPartial: !isClosing,
    issuedAt: note.created_at.toISOString(),
    reason: note.reason,
    refundMethod: note.refund_method as RefundMethod,
    refundMethodLabel: refundMethodLabel(note.refund_method as RefundMethod),
    grossAmountThb: fromDecimal(note.gross_amount),
    discountThb: fromDecimal(note.discount_amount),
    lines: returned,
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
 * subtract. `null` when nothing has been refunded.
 *
 * Summed rather than read off one note, and that is the whole point of partial
 * refunds: a bill credited three times subtracts three amounts, and a report that
 * read only the latest would count the takings as nearly whole.
 */
export async function refundedAmountFor(orderId: string): Promise<number | null> {
  const aggregate = await prisma.credit_notes.aggregate({
    where: { order_id: orderId },
    _sum: { final_amount: true },
    _count: { _all: true },
  });

  return aggregate._count._all === 0 || aggregate._sum.final_amount === null
    ? null
    : roundThb(fromDecimal(aggregate._sum.final_amount));
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

/**
 * The history of a sale's reversals, for the order screen.
 * Cheapest possible read: one row per note, before the amounts are needed, so the
 * screen can decide whether to fetch the documents themselves.
 */
export async function creditNoteHistoryFor(
  orderId: string,
): Promise<{ documentNumber: string; sequence: number; amountThb: number; isLast: boolean }[]> {
  const notes = await prisma.credit_notes.findMany({
    where: { order_id: orderId },
    orderBy: { sequence: 'asc' },
    select: { document_number: true, sequence: true, final_amount: true },
  });

  return notes.map((note, index) => ({
    documentNumber: note.document_number,
    sequence: note.sequence,
    amountThb: fromDecimal(note.final_amount),
    isLast: index === notes.length - 1,
  }));
}

/** Throws the not-found error a route needs, naming the document. */
export async function requireCreditNoteDocument(orderId: string): Promise<CreditNoteDocument> {
  const document = await loadCreditNoteDocument(orderId);
  if (!document) {
    throw new NotFoundError(`No credit note for order ${orderId}`);
  }
  return document;
}
