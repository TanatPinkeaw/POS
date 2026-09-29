/**
 * Closing a borrowed range: how far the device got, or that it printed nothing — ADR 0019.
 *
 * One route for both moves, unlike the pre-order phases (a route each, because each mints
 * something) and like the call board (two buttons, one state machine). These are two
 * answers to one question — "what became of the numbers I took?" — and a block is either
 * *reported* (used through N) or *cancelled* (untouched), never both. A second route would
 * be a second copy of the counter arithmetic, and the copy that drifts is the one that
 * gives the unused tail back wrong.
 *
 * This is also the admin's way out of a device that never came back: the same call, made
 * from a screen rather than from the tablet, with the last number read off the paper.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { cancelNumberBlock, reportNumberBlock } from '@/lib/number-blocks';
import { closeNumberBlockSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const { id } = await context.params;
    const body = await readJson(request, closeNumberBlockSchema);

    if (body.action === 'cancel') {
      return cancelNumberBlock({ id, userId: session.id });
    }
    return reportNumberBlock({ id, lastUsed: body.lastUsed, userId: session.id });
  });
}
