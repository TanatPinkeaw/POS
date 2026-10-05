/**
 * The till handing a receipt link to the customer display.
 *
 * The till mints the link itself from the receipt-link route (staff-only, one
 * order, expiring) and posts what it was given here; the server re-emits it
 * trimmed to the fields a queue may see. Same shape as the cart post one door
 * over: the till never emits on the socket itself, and posting `null` clears
 * the screen — after the customer has scanned, or when the next sale begins.
 *
 * Fire-and-forget like the cart: a screen that misses it keeps whatever it had,
 * and a till that cannot reach this endpoint must never refuse a sale because
 * of it.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastReceiptLink } from '@/lib/display-broadcast';
import { displayReceiptSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);
    const body = await readJson(request, displayReceiptSchema);

    broadcastReceiptLink(
      body === null
        ? null
        : {
            orderNumber: body.orderNumber,
            token: body.token,
            path: body.path,
          },
    );

    return { ok: true };
  });
}
