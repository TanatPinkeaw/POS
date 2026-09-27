import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastStockFor } from '@/lib/broadcast';
import { ForbiddenError } from '@/lib/errors';
import { loadOrderView } from '@/lib/order-view';
import { cancelOrder } from '@/lib/orders';
import { notifyOrderUpdated } from '@/lib/notify';
import { cancelOrderSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * SRS §3 — cancellation from any live phase, always restoring stock.
 *
 * A member may cancel their own order while it is still theirs to cancel; staff
 * may cancel any, which covers the out-of-stock and no-show cases.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member', 'employee', 'admin']);
    const { id } = await context.params;
    const body = await readJson(request, cancelOrderSchema);

    if (session.role === 'member') {
      const existing = await loadOrderView(id);
      if (existing.customer?.id !== session.id) {
        throw new ForbiddenError('You can only cancel your own orders');
      }
    }

    const result = await cancelOrder({
      orderId: id,
      actorId: session.id,
      reason: body.reason,
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

    return { ...order, releasedLines: result.releasedLines };
  });
}
