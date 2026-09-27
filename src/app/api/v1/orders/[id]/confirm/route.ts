import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastStockFor } from '@/lib/broadcast';
import { loadOrderView } from '@/lib/order-view';
import { confirmOrder } from '@/lib/orders';
import { notifyOrderUpdated } from '@/lib/notify';
import { confirmOrderSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * SRS §3 Phase 2 — staff accept the order, optionally dropping broken items.
 *
 * Removing a line releases its reserved stock immediately, so an item that was
 * damaged on the shelf becomes sellable to someone else straight away.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const { id } = await context.params;
    const body = await readJson(request, confirmOrderSchema);

    await confirmOrder({
      orderId: id,
      employeeId: session.id,
      removeItemIds: body.removeItemIds,
    });

    const order = await loadOrderView(id);
    notifyOrderUpdated({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      orderType: order.orderType,
      customerId: order.customer?.id ?? null,
      finalAmountThb: order.finalAmountThb,
    });
    await broadcastStockFor(order.items.map((item) => item.productId));

    return order;
  });
}
