import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { resolveBangkokRange } from '@/lib/bangkok-time';
import { broadcastPointsFor, broadcastStockFor } from '@/lib/broadcast';
import { prisma } from '@/lib/db';
import { ConflictError } from '@/lib/errors';
import { broadcastPaymentClosed } from '@/lib/display-broadcast';
import { roundThb } from '@/lib/money';
import { findIntent } from '@/lib/payment-intents';
import { listOrderViews } from '@/lib/order-view';
import { createPosSale, placePreOrder } from '@/lib/orders';
import { notifyNewPreOrder, notifyOrderUpdated, notifyQueueChanged } from '@/lib/notify';
import { createOrderSchema, orderListQuerySchema } from '@/lib/schemas';
import { supervisorDiscountLimit } from '@/lib/shop';
import { requireApproval } from '@/lib/supervisor';
import { discountApprovalTarget } from '@/lib/supervisor-view';

/** Members see only their own orders; staff see the whole shop. */
export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member', 'employee', 'admin']);

    const params = new URL(request.url).searchParams;
    const query = orderListQuerySchema.parse({
      status: params.get('status') ?? undefined,
      type: params.get('type') ?? undefined,
      limit: params.get('limit') ?? undefined,
      receiptNumber: params.get('receiptNumber') ?? undefined,
      customerName: params.get('customerName') ?? undefined,
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      offset: params.get('offset') ?? undefined,
    });

    /*
     * The history filters are resolved to Bangkok instants here rather than in the
     * projection, because a day range is a calendar question (rule 10) and the caller
     * that has to get it right is the route, not the query builder. `to` is inclusive
     * of the named day, so it widens to the next Bangkok midnight before it queries —
     * otherwise "1–31 August" quietly excludes every sale after midnight on the 31st,
     * which is the one sale a month-end reconciliation is looking for.
     *
     * Only when a range was actually asked for: the boards pass no dates, and
     * defaulting them would hide every order that is not from the last thirty days
     * from a board whose whole job is to show what is in front of the shop.
     */
    const range = query.from || query.to ? resolveBangkokRange({ from: query.from, to: query.to }) : null;

    return listOrderViews({
      statuses: query.status ? [query.status] : undefined,
      orderType: query.type,
      customerId: session.role === 'member' ? session.id : undefined,
      limit: query.limit,
      ...(query.receiptNumber ? { receiptNumber: query.receiptNumber } : {}),
      ...(query.customerName ? { customerName: query.customerName } : {}),
      ...(range ? { from: range.fromDate, toExclusive: range.toExclusive } : {}),
      offset: query.offset,
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
      /*
       * A discount past the shop's own limit is not the cashier's to give.
       *
       * The check happens before the sale is attempted rather than inside it, so
       * a refused approval cannot leave a priced-and-voided cart behind, and the
       * amount is what the approval is bound to — the order number does not exist
       * yet, and the amount is the thing that was actually authorised.
       */
      const discountThb = roundThb(body.discountThb ?? 0);
      const limitThb = await supervisorDiscountLimit();

      const approval =
        discountThb > limitThb
          ? await requireApproval(
              request,
              'over_discount',
              discountApprovalTarget(discountThb),
            )
          : null;
      const session = approval ? approval.actor : await requireRole(['employee', 'admin']);

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
        ...(approval ? { overDiscountApproval: { approverId: approval.approverId, limitThb } } : {}),
        ...(body.intentRef ? { intentRef: body.intentRef } : {}),
        /*
         * Passed straight through: a till holding a borrowed block printed this bill's
         * numbers itself, and refusing to carry them would mean allocating a number
         * beside a loan the freeze forbids — a 409 for a sale that already happened at
         * the counter (ADR 0019). The endpoint is the one place that must not "fix up"
         * a device's number; the validation inside the sale is.
         */
        ...(body.deviceNumbers ? { deviceNumbers: body.deviceNumbers } : {}),
      });

      // The customer's QR is spent and the bill is closed, so both screens stop
      // showing a code that is no longer payable.
      if (body.intentRef) {
        const consumed = await findIntent(body.intentRef);
        if (consumed) {
          broadcastPaymentClosed(consumed);
        }
      }

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
      /*
       * The bar's board gains a ticket the instant the bill is paid — the number is
       * already on the customer's slip, so a board that showed it a minute later
       * would be a board the bar stops trusting (ADR 0018).
       */
      notifyQueueChanged();

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
