/**
 * `POST /api/v1/orders/[id]/receipt-link` — mint a signed receipt link at the
 * counter (ADR 0021 §3).
 *
 * This is how a walk-in gets a receipt: the cashier asks for a link for the sale in
 * front of them, and hands it over — printed, shown as a QR, or read out. The link
 * names exactly one order and expires; see `src/lib/receipt-link.ts` for why those
 * properties are the whole point.
 *
 * Staff-only, because it mints a credential for somebody else's document. It mints
 * a **fresh** link on every call rather than returning a stable one (reissue rather
 * than reuse), so one leaked link never becomes the permanent key to an order.
 *
 * Two refusals, and they mean different things:
 *
 *   * The order is not a completed (or refunded) sale — a 409. There is no receipt
 *     yet to link to.
 *   * The sale has aged past the one-month window — a 410. The bill still exists and
 *     still reprints; the customer is simply no longer offered the file.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ConflictError, NotFoundError } from '@/lib/errors';
import { createReceiptLink, ReceiptWindowClosedError } from '@/lib/receipt-link';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);

    const { id } = await context.params;
    const order = await prisma.orders.findUnique({
      where: { id },
      select: { id: true, order_number: true, status: true, completed_at: true, created_at: true },
    });

    if (!order) {
      throw new NotFoundError('ไม่พบออเดอร์ที่ระบุ', `Order ${id}`);
    }
    if (order.status !== 'completed' && order.status !== 'refunded') {
      throw new ConflictError(
        `Order ${order.order_number} is ${order.status}; only a completed sale has a receipt`,
        'ORDER_NOT_COMPLETED',
      );
    }

    const token = await createReceiptLink({
      orderId: order.id,
      soldAt: order.completed_at ?? order.created_at,
    });
    if (token === null) {
      throw new ReceiptWindowClosedError();
    }

    // The path rather than an absolute URL: the server does not know the origin a
    // shop is reached on, so whoever shows the link prefixes its own.
    return { token, path: `/api/v1/receipts/${token}` };
  });
}
