import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { broadcastReadyBoard } from '@/lib/display-broadcast';
import { collectTicket, markTicketReady } from '@/lib/fulfilment';
import { notifyQueueChanged } from '@/lib/notify';
import { fulfilmentActionSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * One step of the call board (ADR 0018): the drink is made, or it has gone.
 *
 * One route for both moves, unlike the pre-order phases, which are a route each
 * because each of them *mints* something — a PIN, a settlement. These are two
 * buttons on one ticket and one state machine, and the half that silently goes
 * wrong is the half that gets duplicated: two routes would be two copies of the
 * board refresh below, and the second copy is the one somebody forgets.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    // Employees too, and this is the point of the whole round: the person making
    // the drink is at the counter, and a screen only an owner can reach is a screen
    // a small shop never opens.
    await requireRole(['employee', 'admin']);

    const { id } = await context.params;
    const { action } = await readJson(request, fulfilmentActionSchema);

    const ticket = action === 'mark_ready' ? await markTicketReady(id) : await collectTicket(id);

    // The bar's own screen is nudged and re-reads the board; the customer screen is
    // handed the board, because it has no session to read it with. Both happen after
    // the write committed, so neither screen can show a move that was refused.
    notifyQueueChanged();
    await broadcastReadyBoard();

    return ticket;
  });
}
