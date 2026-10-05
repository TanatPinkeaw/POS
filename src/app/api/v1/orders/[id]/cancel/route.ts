import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastStockFor } from '@/lib/broadcast';
import { broadcastReadyBoard } from '@/lib/display-broadcast';
import { ForbiddenError } from '@/lib/errors';
import { loadOrderView } from '@/lib/order-view';
import { cancelOrder } from '@/lib/orders';
import { notifyOrderUpdated } from '@/lib/notify';
import { cancelOrderSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * SRS §3 — cancellation from any live phase, always restoring stock.
 *
 * A member may cancel their own order while it is still theirs to cancel; staff may
 * cancel any (ADR 0026).
 *
 * **Why staff no longer need a supervisor PIN here.** This route used to call
 * `requireApproval(request, 'void_order', id)`, which meant an employee could not
 * cancel *any* pre-order — not their own, not a mistake they had just made, not one
 * they had themselves entered at the counter ten seconds earlier. The PIN belongs to
 * the walk-in till's "ยกเลิกบิล" button, where the thing being reversed is money that
 * has already changed hands and the person pressing the button did not take it in. A
 * pre-order that has not been confirmed yet holds nothing but a reservation, and
 * releasing a reservation is a shelf decision, not a financial one.
 *
 * Leaving the gate in place had a second cost that is easy to miss: the PIN prompt is
 * not wired into this screen at all, so an employee who pressed "ยกเลิก" got a bare
 * 403 and no way forward. A rule that cannot be satisfied from the screen is a rule
 * that reads as a broken button.
 *
 * What replaces it is not silence. Every staff cancellation writes a `void_order`
 * audit row naming the employee — see `cancelOrder` — so the trail still answers "who
 * released this reservation", which is the question an owner actually asks. The rule
 * changed from *who may press it* to *who pressed it*.
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
      // The one bit of the actor the audit row needs to decide what kind of event
      // this is. A member withdrawing their own basket is not something the shop has
      // to account for; staff releasing somebody else's reservation is.
      staffVoid: session.role !== 'member',
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