import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { syncOfflineBatch } from '@/lib/offline-sales';
import { broadcastStockFor } from '@/lib/broadcast';
import { notifyQueueChanged } from '@/lib/notify';
import { offlineSyncSchema } from '@/lib/schemas';

/**
 * The offline replay — the one door a device's queue comes through (ADR 0019 decision 5).
 *
 * **The contract, in the order it matters to the device.**
 *
 * 1. It posts the bills it is holding, in its own sequence, plus the loans it wants closed.
 * 2. Every bill it gets an answer for is **spent**: remove it from the queue. An entry
 *    reported as `recorded` is now a bill in the shop; a `duplicate` one was already there
 *    (this is a retry, a timeout or a double-send, and the answer is the same either way);
 *    a `refused` one is still the device's, with a typed reason and a sentence to show.
 * 3. A bill absent from the answer was **never attempted** — the batch stops at the first
 *    refusal, and the response says how many were left (`notAttempted`). Retry them first,
 *    in order, once the refused one can be reconciled.
 *
 * Nothing here throws for a refused bill. A refusal is a *result*, because a batch is a report
 * about several bills: one bad number in the middle is data the till has to show, not a failed
 * request — and an HTTP error would make the device's own bookkeeping ("which client
 * references did the server accept") depend on parsing an error body. Errors that are not
 * domain refusals are still errors, and `withApi` turns them into a 500.
 *
 * Both roles that stand at a till may sync. `member` never: a customer's browser has no queue
 * and no drawer, and this handler writes cash against one.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, offlineSyncSchema);

    const result = await syncOfflineBatch({
      cashierId: session.id,
      shiftId: body.shiftId,
      bills: body.bills,
      reports: body.reports,
    });
    await broadcastStockFor([...new Set(body.bills.flatMap((bill) => bill.lines.map((line) => line.productId)))]);
    notifyQueueChanged();
    return result;
  });
}
