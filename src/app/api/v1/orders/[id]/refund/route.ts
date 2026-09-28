/**
 * `POST /api/v1/orders/[id]/refund` — reverse a paid sale and issue a credit note.
 *
 * Gated unconditionally, and that is the difference between this and cancelling:
 * a cancel stops an order that was never paid, while this hands money back out
 * of the drawer. It is therefore always a supervisor's decision — never the
 * cashier's own, and never inferred from their role. An owner alone in the shop
 * approves their own refund by entering their own PIN, which leaves a trail
 * naming both roles rather than an unaudited hole.
 *
 * Everything else about the reversal lives in `refundOrder`: the transaction, the
 * gapless credit-note number, the arithmetic that turns "these three of those five"
 * into an amount, the stock coming back, the points reversal and the audit row.
 * This file is the authorisation and the fan-out to the screens that have to stop
 * believing what they were showing.
 *
 * A body with no `lines` is a full refund of whatever is left, which is what the
 * till sent before partial refunds existed.
 */
import { readJson, withApi } from '@/lib/api';
import { broadcastStockFor } from '@/lib/broadcast';
import { refundOrder } from '@/lib/credit-notes';
import { broadcastReadyBoard } from '@/lib/display-broadcast';
import { loadOrderView } from '@/lib/order-view';
import { notifyOrderUpdated } from '@/lib/notify';
import { refundOrderSchema } from '@/lib/schemas';
import { requireApproval } from '@/lib/supervisor';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const { id } = await context.params;
    const body = await readJson(request, refundOrderSchema);

    /*
     * The approval is bound to the order id, so an approval to refund one bill
     * cannot be spent on another — which matters more here than anywhere else,
     * because the target is the thing the amount comes from.
     */
    const { actor, approverId } = await requireApproval(request, 'refund_order', id);

    const summary = await refundOrder({
      orderId: id,
      actorId: actor.id,
      reason: body.reason,
      refundMethod: body.refundMethod,
      shiftId: body.shiftId ?? null,
      lines: body.lines ?? null,
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

    // The shelf changed, so every open board — the till's catalogue, the
    // customer's availability view — has to hear about it. A refunded pre-order
    // must also leave the collection board, for the same reason a cancelled one
    // does: a parcel on that screen sends a customer to the counter for
    // something that is no longer waiting for them.
    await broadcastStockFor(order.items.map((item) => item.productId));
    if (order.orderType === 'preorder') {
      await broadcastReadyBoard();
    }

    return summary;
  });
}
