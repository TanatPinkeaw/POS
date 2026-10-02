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
 * The one-month access window (ADR 0021 §2) does **not** apply to staff: it withholds a
 * customer's own download, whereas the shop's reprint is a retention obligation that
 * must keep working for years. So this route branches on role, which is the one place
 * the two rules meet:
 *
 *   * **Staff** (employee, admin) reprint any completed sale, unwindowed.
 *   * **A member** reaches only their own order, and the window *is* enforced — the
 *     customer portal's download is the customer's download (`loadCustomerReceipt`).
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { loadCustomerReceipt } from '@/lib/customer-portal';
import { loadReceiptPayload } from '@/lib/order-view';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member', 'employee', 'admin']);
    const { id } = await context.params;

    // A member's own receipt, windowed; staff reprint anything, unwindowed.
    const { shop, receipt } =
      session.role === 'member'
        ? await loadCustomerReceipt(id, session.id)
        : await loadReceiptPayload(id);

    // `soldAt` is dropped here: it exists only for the access window.
    return { shop, receipt };
  });
}
