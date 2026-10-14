/**
 * `GET /api/v1/members/:id/line-messages` — what one customer asked the shop
 * (ADR 0032 §3, §8).
 *
 * Admin-only like every other read of a customer row, and deliberately its own route rather
 * than a field on the customer list: the list is a shop's whole customer base, and a shop
 * with no LINE customers should pay nothing for a feature it does not use. The list carries
 * only the *count* per customer (one grouped query, already read on the server); this door
 * is opened when somebody actually wants to read them.
 *
 * No `text` is returned for anything that is not a text message, because none was stored —
 * this deployment holds no files (ADR 0014), so a picture is recorded as a picture rather
 * than downloaded into a place nothing here can back up.
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { recentMessagesForUser } from '@/lib/line-messages';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const { id } = await context.params;

    return { messages: await recentMessagesForUser(id, 20) };
  });
}
