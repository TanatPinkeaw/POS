/**
 * `GET /api/v1/orders/[id]/receipt` — reprint data for a completed sale (ADR 0002).
 *
 * A stored invoice number is worthless if the document behind it cannot be
 * produced again, so this exists alongside the numbering rather than after it.
 *
 * Everything it returns is read from the order's own *snapshot* columns —
 * `vat_rate_used`, `net_amount`, `vat_amount`, `receipt_number` — never from the
 * shop's current settings. A reprint of a 2026 receipt must show 7% even if the
 * rate has since changed, and must show the shop's name as it is *now*, which is
 * the one field that legitimately follows the settings: a renamed shop reprints
 * under its new name rather than resurrecting the old one.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { fromDecimal } from '@/lib/money';
import { formatQueueNumber } from '@/lib/queue-number';
import { loadShop } from '@/lib/shop';
import { UNCONFIGURED_SHOP } from '@/lib/shop-view';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    // Employees too: the person at the counter is the one asked for a copy.
    await requireRole(['employee', 'admin']);

    const { id } = await context.params;

    const order = await prisma.orders.findUnique({
      where: { id },
      include: {
        items: { include: { product: { select: { name: true } } }, orderBy: { id: 'asc' } },
        payments: true,
      },
    });

    if (!order) {
      throw new NotFoundError(`Order ${id}`);
    }
    /*
     * A refunded sale keeps its receipt. The invoice was issued, it was handed
     * to a customer, and nothing un-issues it — the credit note is a second
     * document beside it rather than a replacement. Refusing the reprint would
     * lose the only record of what the customer originally paid, which is
     * exactly what they need to be shown when they ask where their refund went.
     */
    if (order.status !== 'completed' && order.status !== 'refunded') {
      throw new ConflictError(
        `Order ${order.order_number} is ${order.status}; only a completed sale has a receipt`,
        'ORDER_NOT_COMPLETED',
      );
    }

    const shop = (await loadShop()) ?? UNCONFIGURED_SHOP;

    /*
     * Points are a settlement discount rather than money, so they are excluded
     * from "received" — otherwise the receipt would claim the customer handed
     * over cash that nobody put in the drawer. Refund legs are excluded for the
     * mirror-image reason: this is the document for what the customer *paid*, and
     * after a refund the order's payments contain a leg going the other way. A
     * reprint that showed it would print a receipt whose tenders no longer add up
     * to what was received.
     */
    const money = order.payments.filter(
      (payment) => payment.method !== 'points' && payment.direction === 'sale',
    );
    const changeThb = money.reduce(
      (largest, payment) => Math.max(largest, fromDecimal(payment.change_amount ?? 0)),
      0,
    );
    /*
     * The tender lines come from the stored `received_amount`, not from the
     * order total: a ฿100 note against a ฿35 bill must reprint as 100.00 rather
     * than re-deriving 35.00 and contradicting the change beside it.
     */
    const tenders = money.map((payment) => ({
      method: payment.method,
      amountThb: fromDecimal(payment.amount),
      receivedThb:
        payment.received_amount === null ? null : fromDecimal(payment.received_amount),
    }));

    return {
      shop,
      receipt: {
        orderNumber: order.order_number,
        receiptNumber: order.receipt_number,
        /*
         * Formatted here, from the stored integer, so a reprint carries the same
         * `037` the customer was called by rather than a bare `37` that no longer
         * matches the slip in their hand (ADR 0017).
         */
        queueNumber:
          order.queue_number === null ? null : formatQueueNumber(order.queue_number),
        isVatInvoice: order.is_vat_invoice,
        vatRatePercent: order.vat_rate_used === null ? null : fromDecimal(order.vat_rate_used),
        netThb: fromDecimal(order.net_amount),
        vatThb: fromDecimal(order.vat_amount),
        subtotalThb: fromDecimal(order.subtotal_amount),
        discountThb: fromDecimal(order.discount_amount),
        finalAmountThb: fromDecimal(order.final_amount),
        changeThb,
        tenders,
        pointsEarned: order.points_earned,
        pointsRedeemed: order.points_redeemed,
        createdAt: order.created_at.toISOString(),
        lines: order.items.map((item) => ({
          name: item.product.name,
          quantity: item.quantity,
          unitPrice: fromDecimal(item.unit_price),
          totalPrice: fromDecimal(item.total_price),
        })),
      },
    };
  });
}
