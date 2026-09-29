import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { listQueueTickets } from '@/lib/fulfilment';

/**
 * Today's call board, as the bar's screen reads it (ADR 0018).
 *
 * A read of the table rather than a stream of events, so a screen that was asleep,
 * reloaded, or opened an hour after the shop got busy shows the same board as one
 * that has been watching all along. The realtime event is a nudge to call this
 * again, never the source of what is on it — the same rule the customer screen's
 * board follows, for the same reason.
 */
export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);

    return { tickets: await listQueueTickets() };
  });
}
