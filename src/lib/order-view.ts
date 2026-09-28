/**
 * Read-side projections for orders.
 *
 * Two shapes on purpose: the boards need a cheap list, and the handover screen
 * needs one fully-loaded order. Both convert Prisma `Decimal` columns to plain
 * numbers here, so no route handler has to remember to do it and nothing leaks
 * a Decimal into JSON.
 */
import { prisma } from './db';
import { NotFoundError } from './errors';
import { fromDecimal, sumThb } from './money';
import type { OrderStatus } from './order-state';
import { createPickupToken } from './pickup-token';

export interface OrderItemView {
  id: string;
  productId: string;
  name: string;
  barcode: string | null;
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
  createdAt: Date;
  readyAt: Date | null;
}

const fullInclude = {
  items: {
    include: {
      product: { select: { name: true, barcode: true } },
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
    throw new NotFoundError(`Order ${orderId}`);
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
}): Promise<OrderListView[]> {
  const orders = await prisma.orders.findMany({
    where: {
      ...(filter.statuses ? { status: { in: filter.statuses } } : {}),
      ...(filter.orderType ? { order_type: filter.orderType } : {}),
      ...(filter.customerId ? { customer_id: filter.customerId } : {}),
    },
    include: {
      customer: { select: { full_name: true, phone: true } },
      _count: { select: { items: true } },
    },
    orderBy: { created_at: 'desc' },
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
      createdAt: order.created_at,
      readyAt: order.ready_at,
    })),
  );
}
