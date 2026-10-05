/**
 * The till telling the customer display what is on the bill.
 *
 * The till already holds a socket, but it does not *emit* on it: a client that can
 * write to the display channel is a client that can put anything on a customer's
 * screen, and the whitelist in `display-view.ts` would stop meaning anything.
 * So the cart is posted here and re-emitted by the server, which is also where it
 * is trimmed to the fields the screen is allowed to see — an over-sharing bug at
 * this boundary would otherwise ship the cost price of everything in the basket.
 *
 * Fire-and-forget by design: a display that misses one snapshot gets the next one,
 * and a till that cannot reach this endpoint must never refuse a sale because of
 * it.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastCart } from '@/lib/display-broadcast';
import { displayCartSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);
    const body = await readJson(request, displayCartSchema);

    broadcastCart({
      lines: body.lines.map((line) => ({
        name: line.name,
        quantity: line.quantity,
        totalPrice: line.totalPrice,
        unitPrice: line.unitPrice,
        imageUrl: line.imageUrl ?? null,
      })),
      subtotalThb: body.subtotalThb,
      discountThb: body.discountThb,
      totalThb: body.totalThb,
      receivedThb: body.receivedThb ?? null,
      changeThb: body.changeThb ?? null,
      memberFirstName: body.memberFirstName ?? null,
    });

    return { ok: true };
  });
}
