/**
 * Read-side projections for orders.
 *
 * Two shapes on purpose: the boards need a cheap list, and the handover screen
 * needs one fully-loaded order. Both convert Prisma `Decimal` columns to plain
 * numbers here, so no route handler has to remember to do it and nothing leaks
 * a Decimal into JSON.
 */
import type { ReceiptData } from '@/components/pos/Receipt';

import { prisma } from './db';
import { ConflictError, NotFoundError } from './errors';
import { fromDecimal, sumThb } from './money';
import type { OrderStatus } from './order-state';
import { createPickupToken } from './pickup-token';
import { formatQueueNumber } from './queue-number';
import { receiptWithinAccessWindow } from './receipt-access';
import { ReceiptWindowClosedError, verifyReceiptToken } from './receipt-link';
import { loadShop } from './shop';
import { UNCONFIGURED_SHOP, type ShopView } from './shop-view';

export interface OrderItemView {
  id: string;
  productId: string;
  name: string;
  barcode: string | null;
  /**
   * The product's picture, wherever the shop keeps it (ADR 0014).
   *
   * It rides on the order line because the line is where a photo is worth the most:
   * the pre-order board lists what has to go in a bag, and "which bag on the shelf is
   * this order's" is a question an order number cannot answer and a picture can. Null
   * on every product the shop has not given a link to, and the screen draws its
   * placeholder instead.
   */
  imageUrl: string | null;
  quantity: number;
  /** How many of `quantity` have already been refunded, across every credit note. */
  refundedQuantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface OrderPaymentView {
  id: number;
  method: string;
  amountThb: number;
  receivedThb: number | null;
  changeThb: number | null;
  paidAt: Date;
}

export interface OrderView {
  id: string;
  orderNumber: string;
  orderType: string;
  status: OrderStatus;
  subtotalThb: number;
  discountThb: number;
  finalAmountThb: number;
  pointsEarned: number;
  pointsRedeemed: number;
  pickupPin: string | null;
  pickupExpiresAt: Date | null;
  cancelReason: string | null;
  /**
   * The credit note that reversed this sale, when there is one.
   *
   * Read through the order rather than fetched separately because every caller
   * that has an order in hand may need to offer its document — the till's history
   * row, the receipt screen, the manager's recent-orders table — and a second
   * round trip per row is how a list of fifty becomes a slow screen.
   */
  creditNoteNumber: string | null;
  /** How many credit notes this sale carries — one per refund visit. */
  creditNoteCount: number;
  /** Everything given back so far, across every note. */
  refundedThb: number;
  createdAt: Date;
  confirmedAt: Date | null;
  readyAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  customer: { id: string; fullName: string; phone: string; pointsBalance: number } | null;
  cashier: { id: string; fullName: string } | null;
  items: OrderItemView[];
  payments: OrderPaymentView[];
}

export interface OrderListView {
  id: string;
  orderNumber: string;
  orderType: string;
  status: OrderStatus;
  finalAmountThb: number;
  itemCount: number;
  customerName: string | null;
  customerPhone: string | null;
  pickupPin: string | null;
  /**
   * The signed code behind the handover QR — SRS §3.
   *
   * Minted here rather than stored: it is derivable from the order id and the
   * hold's own deadline (`src/lib/pickup-token.ts`), so there is no column to keep
   * in step and no secret at rest to leak. Null unless the order is actually
   * waiting to be collected, because a code for anything else is a code that can
   * collect nothing.
   */
  pickupToken: string | null;
  /**
   * When an unconfirmed pre-order stops waiting (SRS §3 Phase 1).
   *
   * Sent to the screen instead of the timeout in minutes, and this is the second time
   * that decision has been made in the wrong place. The board used to carry its own
   * `CONFIRM_TIMEOUT_MINUTES = 15` and count down from `createdAt`, which meant the
   * figure a cashier read was whatever the env var said on the server *and* whatever
   * the compiled JavaScript said — two numbers that agree only until somebody changes
   * the shop's timeout, at which point the countdown and the sweeper disagree and the
   * board announces an expiry the server is not going to perform.
   *
   * The deadline is already a column, written once when the order is placed, so the
   * display and the sweeper now read the same value by construction and there is no
   * second place to change when the shop changes its mind.
   */
  confirmDeadline: Date | null;
  createdAt: Date;
  readyAt: Date | null;
  /**
   * The tax-invoice number, for the sales-history screen (#9).
   *
   * Null on anything that never became a sale. It is in the list projection rather
   * than fetched per row because the one screen that lists a lot of orders is the one
   * that prints them, and a second round trip per order is how that screen becomes
   * the slow one.
   */
  receiptNumber: string | null;
  /** When the sale closed — the receipt's own timestamp, for ordering and filtering. */
  completedAt: Date | null;
}

const fullInclude = {
  items: {
    include: {
      product: { select: { name: true, barcode: true, image_url: true } },
      /*
       * What has already gone back on each line, so a screen can offer what is left
       * rather than what was sold. Without it the refund dialog would have to ask a
       * second question, and a till that asks two questions mid-sale is a till
       * somebody refunds the wrong line from.
       */
      refunded_on: { select: { quantity: true } },
    },
    orderBy: { id: 'asc' as const },
  },
  payments: { orderBy: { id: 'asc' as const } },
  customer: { select: { id: true, full_name: true, phone: true, points_balance: true } },
  cashier: { select: { id: true, full_name: true } },
  credit_notes: {
    select: { document_number: true, sequence: true, final_amount: true },
    orderBy: { sequence: 'asc' as const },
  },
};

/** One order with its lines, payments, and parties. */
export async function loadOrderView(orderId: string): Promise<OrderView> {
  const order = await prisma.orders.findUnique({
    where: { id: orderId },
    include: fullInclude,
  });
  if (!order) {
    throw new NotFoundError('ไม่พบออเดอร์ที่ระบุ', `Order ${orderId}`);
  }

  return {
    id: order.id,
    orderNumber: order.order_number,
    orderType: order.order_type,
    status: order.status as OrderStatus,
    subtotalThb: fromDecimal(order.subtotal_amount),
    discountThb: fromDecimal(order.discount_amount),
    finalAmountThb: fromDecimal(order.final_amount),
    pointsEarned: order.points_earned,
    pointsRedeemed: order.points_redeemed,
    pickupPin: order.pickup_pin,
    pickupExpiresAt: order.pickup_expires_at,
    cancelReason: order.cancel_reason,
    /*
     * The latest note, not the only one: a bill can be refunded in pieces, and a
     * screen with room for one reference should show the most recent document. The
     * full history is `creditNoteHistoryFor`.
     */
    creditNoteNumber: order.credit_notes.at(-1)?.document_number ?? null,
    creditNoteCount: order.credit_notes.length,
    refundedThb: sumThb(
      order.credit_notes.map((note) => fromDecimal(note.final_amount as never)),
    ),
    createdAt: order.created_at,
    confirmedAt: order.confirmed_at,
    readyAt: order.ready_at,
    completedAt: order.completed_at,
    cancelledAt: order.cancelled_at,
    customer: order.customer
      ? {
          id: order.customer.id,
          fullName: order.customer.full_name,
          phone: order.customer.phone,
          pointsBalance: order.customer.points_balance,
        }
      : null,
    cashier: order.cashier ? { id: order.cashier.id, fullName: order.cashier.full_name } : null,
    items: order.items.map((item) => ({
      id: String(item.id),
      productId: item.product_id,
      name: item.product.name,
      barcode: item.product.barcode,
      imageUrl: item.product.image_url,
      quantity: item.quantity,
      refundedQuantity: item.refunded_on.reduce((total, line) => total + line.quantity, 0),
      unitPrice: fromDecimal(item.unit_price),
      totalPrice: fromDecimal(item.total_price),
    })),
    payments: order.payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      amountThb: fromDecimal(payment.amount),
      receivedThb: payment.received_amount === null ? null : fromDecimal(payment.received_amount),
      changeThb: payment.change_amount === null ? null : fromDecimal(payment.change_amount),
      paidAt: payment.paid_at,
    })),
  };
}

/** A page of orders without their line detail. */
export async function listOrderViews(filter: {
  statuses?: OrderStatus[];
  orderType?: 'pos_walkin' | 'preorder';
  customerId?: string;
  limit: number;
  /** The sales-history screen's own filters; absent for the boards. */
  receiptNumber?: string;
  customerName?: string;
  /** Bangkok calendar days, already resolved by the caller. */
  from?: Date;
  /** Exclusive — the next Bangkok midnight, from `resolveBangkokRange`. */
  toExclusive?: Date;
  offset?: number;
}): Promise<OrderListView[]> {
  const orders = await prisma.orders.findMany({
    where: {
      ...(filter.statuses ? { status: { in: filter.statuses } } : {}),
      ...(filter.orderType ? { order_type: filter.orderType } : {}),
      ...(filter.customerId ? { customer_id: filter.customerId } : {}),
      /*
       * `contains` rather than an exact match, and case-insensitive by Prisma's own
       * default, because the number a shop has written down is the one a customer read
       * off a receipt and the one a tax inspector asks for. `RC-2026-00007` and
       * `rc-2026-00007` are the same document, and a search that distinguishes them
       * fails exactly when it matters and looks like the document does not exist.
       *
       * It also matches the order number, because a receipt number only exists for a
       * VAT-registered shop — `resolveSaleTax` allocates one out of the receipt series,
       * which is a tax document. A shop that is not registered therefore has
       * `receipt_number` set to null on *every* sale, and a search that only looked
       * there would answer "no such sale" to every number the shop can actually see on
       * its own screen. The two numbers are both printed on the same paperwork, so
       * either one typed should find the sale.
       */
      ...(filter.receiptNumber
        ? {
            OR: [
              { receipt_number: { contains: filter.receiptNumber, mode: 'insensitive' } },
              { order_number: { contains: filter.receiptNumber, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(filter.customerName
        ? {
            customer: {
              is: { full_name: { contains: filter.customerName, mode: 'insensitive' } },
            },
          }
        : {}),
      /*
       * Filtered on the moment the sale *closed*, not the moment it was placed, which
       * is the only one of the two that means "the sales on Tuesday". A pre-order
       * placed on Monday and collected on Wednesday belongs to Wednesday's takings,
       * and filtering on `created_at` would file it under Monday — which is the whole
       * question an owner reconciles a bank statement against.
       */
      ...(filter.from || filter.toExclusive
        ? {
            completed_at: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.toExclusive ? { lt: filter.toExclusive } : {}),
            },
          }
        : {}),
    },
    include: {
      customer: { select: { full_name: true, phone: true } },
      _count: { select: { items: true } },
    },
    orderBy: { created_at: 'desc' },
    skip: filter.offset,
    take: filter.limit,
  });

  return Promise.all(
    orders.map(async (order) => ({
      id: order.id,
      orderNumber: order.order_number,
      orderType: order.order_type,
      status: order.status as OrderStatus,
      finalAmountThb: fromDecimal(order.final_amount),
      itemCount: order._count.items,
      customerName: order.customer?.full_name ?? null,
      customerPhone: order.customer?.phone ?? null,
      pickupPin: order.pickup_pin,
      /*
       * Signing is the only cost of a list read, and it is paid once per order that
       * is actually waiting — normally none of them, and never more than the shop
       * has parcels on the shelf.
       */
      pickupToken:
        order.status === 'ready_for_pickup' && order.pickup_expires_at
          ? await createPickupToken({
              orderId: order.id,
              expiresAt: order.pickup_expires_at,
            })
          : null,
      confirmDeadline: order.confirm_deadline,
      receiptNumber: order.receipt_number,
      createdAt: order.created_at,
      readyAt: order.ready_at,
      completedAt: order.completed_at,
    })),
  );
}

/**
 * The receipt for one sale, as both the reprint screen and the customer's image
 * need it (ADR 0002, ADR 0021).
 *
 * One projection, shared by the DOM reprint and the downloadable image, so a
 * customer comparing the two — or a shop asserting a reprint matches the sale —
 * cannot find a difference caused by one route remembering a field and the other
 * forgetting it. Everything comes from the order's snapshot columns, never from the
 * shop's current settings, except the shop's own identity, which legitimately
 * follows the settings: a renamed shop reprints under its new name.
 */
export interface ReceiptPayload {
  shop: ShopView;
  receipt: ReceiptData;
  /**
   * The instant the download window counts from (ADR 0021 §2): when the sale
   * completed, falling back to when it was created for a row that predates the
   * completed-at column.
   */
  soldAt: Date;
}

/**
 * One order's receipt, resolved from the signed link a customer holds (ADR 0021 §2, §3).
 *
 * The two gates the API route and the printable page both need, in one place so they
 * cannot drift: `verifyReceiptToken` proves we issued a link for this order and it has
 * not expired (422 otherwise), and the access window is recomputed from the order's own
 * sale instant on every read — a link minted on the last day can still see the window
 * close under it (410). Shared rather than duplicated because a link that works on the
 * page but not the API (or the reverse) is a bug nobody would see until a customer did.
 */
export async function loadReceiptByLink(
  token: string,
): Promise<{ shop: ShopView; receipt: ReceiptData }> {
  const { orderId } = await verifyReceiptToken(token);
  const { shop, receipt, soldAt } = await loadReceiptPayload(orderId);

  if (!receiptWithinAccessWindow(soldAt)) {
    throw new ReceiptWindowClosedError();
  }

  return { shop, receipt };
}

export async function loadReceiptPayload(orderId: string): Promise<ReceiptPayload> {
  const order = await prisma.orders.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { product: { select: { name: true } } }, orderBy: { id: 'asc' } },
      payments: true,
    },
  });

  if (!order) {
    throw new NotFoundError('ไม่พบออเดอร์ที่ระบุ', `Order ${orderId}`);
  }
  /*
   * A refunded sale keeps its receipt. The invoice was issued, it was handed to a
   * customer, and nothing un-issues it — the credit note is a second document
   * beside it rather than a replacement. Refusing the reprint would lose the only
   * record of what the customer originally paid, which is exactly what they need to
   * be shown when they ask where their refund went.
   */
  if (order.status !== 'completed' && order.status !== 'refunded') {
    throw new ConflictError(
      `Order ${order.order_number} is ${order.status}; only a completed sale has a receipt`,
      'ORDER_NOT_COMPLETED',
    );
  }

  const shop = (await loadShop()) ?? UNCONFIGURED_SHOP;

  /*
   * Points are a settlement discount rather than money, so they are excluded from
   * "received" — otherwise the receipt would claim the customer handed over cash
   * that nobody put in the drawer. Refund legs are excluded for the mirror-image
   * reason: this is the document for what the customer *paid*, and after a refund
   * the order's payments contain a leg going the other way.
   */
  const money = order.payments.filter(
    (payment) => payment.method !== 'points' && payment.direction === 'sale',
  );
  const changeThb = money.reduce(
    (largest, payment) => Math.max(largest, fromDecimal(payment.change_amount ?? 0)),
    0,
  );
  /*
   * The tender lines come from the stored `received_amount`, not from the order
   * total: a ฿100 note against a ฿35 bill must reprint as 100.00 rather than
   * re-deriving 35.00 and contradicting the change beside it.
   */
  const tenders = money.map((payment) => ({
    method: payment.method,
    amountThb: fromDecimal(payment.amount),
    receivedThb:
      payment.received_amount === null ? null : fromDecimal(payment.received_amount),
  }));

  return {
    shop,
    soldAt: order.completed_at ?? order.created_at,
    receipt: {
      orderNumber: order.order_number,
      receiptNumber: order.receipt_number,
      /*
       * Formatted here, from the stored integer, so a reprint carries the same
       * `037` the customer was called by rather than a bare `37` (ADR 0017).
       */
      queueNumber:
        order.queue_number === null ? null : formatQueueNumber(order.queue_number),
      isVatInvoice: order.is_vat_invoice,
      vatRatePercent: order.vat_rate_used === null ? null : fromDecimal(order.vat_rate_used),
      netThb: fromDecimal(order.net_amount),
      vatThb: fromDecimal(order.vat_amount),
      subtotalThb: fromDecimal(order.subtotal_amount),
      discountThb: fromDecimal(order.discount_amount),
      finalAmountThb: fromDecimal(order.final_amount),
      changeThb,
      tenders,
      pointsEarned: order.points_earned,
      pointsRedeemed: order.points_redeemed,
      createdAt: order.created_at.toISOString(),
      lines: order.items.map((item) => ({
        name: item.product.name,
        quantity: item.quantity,
        unitPrice: fromDecimal(item.unit_price),
        totalPrice: fromDecimal(item.total_price),
      })),
    },
  };
}
