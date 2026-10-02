/**
 * `GET /api/v1/orders/[id]/receipt` — reprint data for a completed sale (ADR 0002).
 *
 * A stored invoice number is worthless if the document behind it cannot be
 * produced again, so this exists alongside the numbering rather than after it.
 *
 * The projection itself lives in `loadReceiptPayload` (`src/lib/order-view.ts`),
 * shared with the customer's downloadable image (ADR 0021) so the screen a manager
 * reprints and the picture a customer keeps are made from one reading of the order.
 * It reads only the order's own *snapshot* columns — `vat_rate_used`, `net_amount`,
 * `vat_amount`, `receipt_number` — never the shop's current settings, except the
 * shop's identity, which legitimately follows the settings: a renamed shop reprints
 * under its new name rather than resurrecting the old one.
 *
 * The one-month access window (ADR 0021 §2) does **not** apply here. It withholds a
 * customer's own download; the shop's reprint is a retention obligation and must
 * keep working for years, which is why this route is deliberately unwindowed while
 * `/api/v1/receipts/[token]` is not.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { loadReceiptPayload } from '@/lib/order-view';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    // Employees too: the person at the counter is the one asked for a copy.
    await requireRole(['employee', 'admin']);

    const { id } = await context.params;
    const { shop, receipt } = await loadReceiptPayload(id);

    // `soldAt` is dropped here: it exists for the access window, which this route
    // does not enforce.
    return { shop, receipt };
  });
}
