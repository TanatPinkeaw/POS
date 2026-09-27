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
import { fromDecimal } from './money';
import type { OrderStatus } from './order-state';

export interface OrderItemView {
  id: string;
  productId: string;
  name: string;
  barcode: string | null;
  quantity: number;
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
  createdAt: Date;
  readyAt: Date | null;
}

const fullInclude = {
  items: { include: { product: { select: { name: true, barcode: true } } }, orderBy: { id: 'asc' as const } },
  payments: { orderBy: { id: 'asc' as const } },
  customer: { select: { id: true, full_name: true, phone: true, points_balance: true } },
  cashier: { select: { id: true, full_name: true } },
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

  return orders.map((order) => ({
    id: order.id,
    orderNumber: order.order_number,
    orderType: order.order_type,
    status: order.status as OrderStatus,
    finalAmountThb: fromDecimal(order.final_amount),
    itemCount: order._count.items,
    customerName: order.customer?.full_name ?? null,
    customerPhone: order.customer?.phone ?? null,
    pickupPin: order.pickup_pin,
    createdAt: order.created_at,
    readyAt: order.ready_at,
  }));
}
