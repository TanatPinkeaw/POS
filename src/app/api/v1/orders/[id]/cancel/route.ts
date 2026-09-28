import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastStockFor } from '@/lib/broadcast';
import { broadcastReadyBoard } from '@/lib/display-broadcast';
import { ForbiddenError } from '@/lib/errors';
import { loadOrderView } from '@/lib/order-view';
import { cancelOrder } from '@/lib/orders';
import { notifyOrderUpdated } from '@/lib/notify';
import { cancelOrderSchema } from '@/lib/schemas';
import { requireApproval } from '@/lib/supervisor';

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

    /*
     * A member withdrawing their own pre-order needs nothing extra — it is their
     * basket and their decision. Staff cancelling somebody else's order is the
     * till's ยกเลิกบิล, and that is gated: it releases reserved stock, moves an
     * order to a terminal state, and is the first thing an owner looks for when
     * they suspect the numbers.
     */
    let approverId: string | null = null;
    if (session.role === 'member') {
      const existing = await loadOrderView(id);
      if (existing.customer?.id !== session.id) {
        throw new ForbiddenError('You can only cancel your own orders');
      }
    } else {
      approverId = (await requireApproval(request, 'void_order', id)).approverId;
    }

    const result = await cancelOrder({
      orderId: id,
      actorId: session.id,
      reason: body.reason,
      authorizedByUserId: approverId,
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

    // A cancelled pre-order must leave the collection board as surely as a
    // collected one: a cancelled parcel on the screen sends a customer to the
    // counter for something that is not there. See the note in the complete route.
    if (order.orderType === 'preorder') {
      await broadcastReadyBoard();
    }

    return { ...order, releasedLines: result.releasedLines };
  });
}
