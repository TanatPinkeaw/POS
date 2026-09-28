import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastPointsFor, broadcastStockFor } from '@/lib/broadcast';
import { prisma } from '@/lib/db';
import { broadcastReadyBoard } from '@/lib/display-broadcast';
import { ConflictError } from '@/lib/errors';
import { loadOrderView } from '@/lib/order-view';
import { completeOrder } from '@/lib/orders';
import { notifyOrderUpdated } from '@/lib/notify';
import { completeOrderSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * SRS §3 Phase 4 — handover and settlement.
 *
 * This is where a reservation becomes a real sale: `stock_qty` falls, the
 * reserved units are released, the payment legs are attached to the open
 * drawer, and the customer's points are both redeemed and awarded.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const { id } = await context.params;
    const body = await readJson(request, completeOrderSchema);

    const shift = await prisma.cash_shifts.findUnique({ where: { id: body.shiftId } });
    if (!shift || shift.status !== 'open') {
      throw new ConflictError(`Cash drawer #${body.shiftId} is not open`, 'NO_OPEN_SHIFT');
    }

    const summary = await completeOrder({
      orderId: id,
      employeeId: session.id,
      shiftId: body.shiftId,
      settlement: body.settlement,
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
    await broadcastStockFor(summary.lines.map((line) => line.productId));
    await broadcastPointsFor(order.customer?.id);

    /*
     * A collected pre-order has to leave the customer screen's collection board.
     * The board is rebuilt from the orders table, so this is the same query the
     * "ready" event runs — what matters is that the *removal* is broadcast too,
     * or a screen that stays connected all day keeps calling out a parcel that is
     * already in somebody's bag.
     *
     * Gated on the order type rather than on its previous status: only a pre-order
     * is ever on that board, and a walk-in sale should not pay for a query it
     * cannot have affected.
     */
    if (order.orderType === 'preorder') {
      await broadcastReadyBoard();
    }

    return { ...order, changeThb: summary.changeThb, paidThb: summary.paidThb };
  });
}
