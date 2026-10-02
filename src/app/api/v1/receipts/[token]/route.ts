/**
 * `GET /api/v1/receipts/[token]` — one order's receipt, fetched by its signed link
 * (ADR 0021 §2, §3).
 *
 * **No session, by design.** This is the door a walk-in uses: the customer who never
 * registered holds a link the counter handed over, and the link *is* the credential
 * — a signed token that names exactly one order, carries its own expiry, and cannot
 * be guessed. The same shape as the customer-facing display route, which authenticates
 * with a device token rather than a session.
 *
 * Two gates, and they are different questions:
 *
 *   1. `verifyReceiptToken` proves *we* issued a link for this order and it has not
 *      expired. A tampered, foreign or stale token stops here with a 422.
 *   2. `receiptWithinAccessWindow` asks the second question the token cannot: is the
 *      sale still inside the one-month window? A link minted on the last day is
 *      within its own short life, but the window can close under it — so the window
 *      is recomputed from the order's own sale instant on every read, and a closed
 *      window answers 410 rather than serving a file the customer is no longer
 *      offered.
 *
 * The response is the same `{ shop, receipt }` shape the reprint route returns, so
 * the client draws it with the one renderer it already has. Nothing here writes: a
 * download never touches the order (ADR 0021 §1 — the order is the record, the image
 * is derived).
 */
import { withApi } from '@/lib/api';
import { loadReceiptPayload } from '@/lib/order-view';
import { receiptWithinAccessWindow } from '@/lib/receipt-access';
import { ReceiptWindowClosedError, verifyReceiptToken } from '@/lib/receipt-link';

type RouteContext = { params: Promise<{ token: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const { token } = await context.params;

    const { orderId } = await verifyReceiptToken(token);
    const { shop, receipt, soldAt } = await loadReceiptPayload(orderId);

    if (!receiptWithinAccessWindow(soldAt)) {
      throw new ReceiptWindowClosedError();
    }

    return { shop, receipt };
  });
}
