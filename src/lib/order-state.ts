/**
 * The 4-phase pre-order lifecycle — SRS §3.
 *
 *   pending ──confirm──> confirmed ──mark_ready──> ready_for_pickup ──complete──> completed
 *      │                     │                            │
 *      └──── cancel ─────────┴──────── cancel ────────────┘──> cancelled
 *
 * Kept pure and separate from persistence so that every route handler, the
 * expiry sweeper, and the UI all agree on what is legal, from one source.
 */

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'ready_for_pickup'
  | 'completed'
  | 'cancelled';

export type OrderAction = 'confirm' | 'mark_ready' | 'complete' | 'cancel';

/** status → the actions that may legally be taken from it. */
const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderAction, OrderStatus>>> = {
  pending: { confirm: 'confirmed', cancel: 'cancelled' },
  confirmed: { mark_ready: 'ready_for_pickup', cancel: 'cancelled' },
  ready_for_pickup: { complete: 'completed', cancel: 'cancelled' },
  completed: {},
  cancelled: {},
};

/** True when `action` is a legal move out of `from`. */
export function canTransition(from: OrderStatus, action: OrderAction): boolean {
  return TRANSITIONS[from][action] !== undefined;
}

/** The actions legal from `from`, in lifecycle order. */
export function allowedActions(from: OrderStatus): OrderAction[] {
  const moves = TRANSITIONS[from];
  return (Object.keys(moves) as OrderAction[]).filter((action) => moves[action] !== undefined);
}

/**
 * The status reached by taking `action` from `from`.
 *
 * Throws instead of returning a sentinel: an illegal transition reaching here
 * means a guard was skipped, which is a bug worth surfacing loudly.
 */
export function nextStatus(from: OrderStatus, action: OrderAction): OrderStatus {
  const to = TRANSITIONS[from][action];
  if (to === undefined) {
    throw new Error(
      `Illegal order transition: cannot ${action} an order in status "${from}"`,
    );
  }
  return to;
}

/** True when no further transition is possible. */
export function isTerminal(status: OrderStatus): boolean {
  return allowedActions(status).length === 0;
}

/**
 * True when the order is still claiming stock in `products.reserved_qty`.
 *
 * Phases 1–3 hold a reservation; completion converts it into a real sale and
 * cancellation gives it back. Exactly the non-terminal statuses.
 */
export function holdsReservedStock(status: OrderStatus): boolean {
  return !isTerminal(status);
}
