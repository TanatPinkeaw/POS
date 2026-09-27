/**
 * The Phase 1 timeout guard — SRS §3.
 *
 * An unconfirmed pre-order holds real stock, so it must not hold it forever.
 * Two mechanisms keep this honest:
 *
 *   1. This interval sweeper, which expires stale orders on a timer.
 *   2. A lazy sweep on read (the route handlers call `expireStalePendingOrders`
 *      directly), so expiry is still correct if the process was asleep, or if
 *      the sweeper thread died, or if a second instance holds the advisory lock.
 *
 * Safe to run on more than one instance: the sweep itself takes a
 * transaction-scoped PostgreSQL advisory lock and returns immediately when
 * another process holds it.
 */
import { expireStalePendingOrders } from './orders';
import { REALTIME_EVENTS, emitToAdmins, emitToStaff } from './realtime';

/** Sweep cadence. Short enough that a 15-minute deadline looks punctual. */
const SWEEP_INTERVAL_MS = 30_000;

let timer: NodeJS.Timeout | null = null;

async function sweep(): Promise<void> {
  try {
    const { expired, orderIds } = await expireStalePendingOrders();
    if (expired === 0) {
      return;
    }

    console.log(`[expiry] released stock held by ${expired} unconfirmed pre-order(s)`);
    emitToStaff(REALTIME_EVENTS.orderExpired, { count: expired, orderIds });
    emitToAdmins(REALTIME_EVENTS.orderExpired, { count: expired, orderIds });
  } catch (error) {
    // A failed sweep must never take the process down; the lazy sweep on read
    // will pick the same orders up again.
    console.error('[expiry] sweep failed', error);
  }
}

/** Starts the sweeper. Returns a stop function. */
export function startExpirySweeper(intervalMs: number = SWEEP_INTERVAL_MS): () => void {
  if (timer) {
    return stopExpirySweeper;
  }

  // `unref` keeps this timer from holding the process open on shutdown.
  timer = setInterval(() => void sweep(), intervalMs);
  timer.unref?.();

  // Run once at boot so a restart immediately cleans up whatever expired while
  // the process was down.
  void sweep();

  return stopExpirySweeper;
}

/** Stops the sweeper. */
export function stopExpirySweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
