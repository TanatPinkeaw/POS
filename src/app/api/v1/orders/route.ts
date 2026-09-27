import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastPointsFor, broadcastStockFor } from '@/lib/broadcast';
import { prisma } from '@/lib/db';
import { ConflictError } from '@/lib/errors';
import { listOrderViews } from '@/lib/order-view';
import { createPosSale, placePreOrder } from '@/lib/orders';
import { notifyNewPreOrder, notifyOrderUpdated } from '@/lib/notify';
import { createOrderSchema, orderListQuerySchema } from '@/lib/schemas';

/** Members see only their own orders; staff see the whole shop. */
export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member', 'employee', 'admin']);

    const params = new URL(request.url).searchParams;
    const query = orderListQuerySchema.parse({
      status: params.get('status') ?? undefined,
      type: params.get('type') ?? undefined,
      limit: params.get('limit') ?? undefined,
    });

    return listOrderViews({
      statuses: query.status ? [query.status] : undefined,
      orderType: query.type,
      customerId: session.role === 'member' ? session.id : undefined,
      limit: query.limit,
    });
  });
}

/**
 * Creates an order.
 *
 * A discriminated union rather than two endpoints, because the two order types
 * share a body shape and differ only in what happens next: a walk-in sale
 * settles immediately, a pre-order enters Phase 1 and waits for staff.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const body = await readJson(request, createOrderSchema);

    if (body.type === 'pos_walkin') {
      const session = await requireRole(['employee', 'admin']);

      // A payment has to belong to a drawer to be reconcilable at close
      // (SRS §6.2), so refuse the sale rather than lose the cash.
      const shift = await prisma.cash_shifts.findUnique({ where: { id: body.shiftId } });
      if (!shift || shift.status !== 'open') {
        throw new ConflictError(
          `Cash drawer #${body.shiftId} is not open`,
          'NO_OPEN_SHIFT',
        );
      }

      const summary = await createPosSale({
        cashierId: session.id,
        shiftId: body.shiftId,
        lines: body.lines,
        customerId: body.customerId ?? null,
        manualDiscountThb: body.discountThb ?? 0,
        settlement: body.settlement,
      });

      notifyOrderUpdated({
        orderId: summary.orderId,
        orderNumber: summary.orderNumber,
        status: summary.status,
        orderType: 'pos_walkin',
        customerId: body.customerId ?? null,
        finalAmountThb: summary.finalAmountThb,
      });
      await broadcastStockFor(summary.lines.map((line) => line.productId));
      await broadcastPointsFor(body.customerId);

      return summary;
    }

    // Pre-orders are the member-facing path (SRS §2).
    const session = await requireRole(['member']);
    const placed = await placePreOrder({ customerId: session.id, lines: body.lines });

    notifyNewPreOrder({
      orderId: placed.orderId,
      orderNumber: placed.orderNumber,
      status: placed.status,
      orderType: 'preorder',
      customerId: session.id,
      customerName: session.fullName,
      finalAmountThb: placed.subtotalThb,
    });
    await broadcastStockFor(body.lines.map((line) => line.productId));

    return placed;
  });
}
