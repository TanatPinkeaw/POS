/**
 * The 4-phase pre-order lifecycle — SRS §3.
 *
 *   pending ──confirm──> confirmed ──mark_ready──> ready_for_pickup ──complete──> completed
 *      │                     │                            │                          │
 *      └──── cancel ─────────┴──────── cancel ────────────┘──> cancelled            │
 *                                                                          refund ───┘
 *                                                                             │
 *                                                                             v
 *                                                                         refunded
 *
 * Kept pure and separate from persistence so that every route handler, the
 * expiry sweeper, and the UI all agree on what is legal, from one source.
 *
 * `refunded` is the one transition that leaves a terminal state, and it is the
 * reason this table earns its keep: a refund reverses money that was taken, so
 * twice-refunding a bill is a payout the shop cannot get back. Stating it here
 * means the guarantee is a property of the type rather than a check each route
 * has to remember — `canTransition(status, 'refund')` is false for `cancelled`,
 * for every live phase, and for a bill that has already been refunded.
 */

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'ready_for_pickup'
  | 'completed'
  | 'cancelled'
  | 'refunded';

/**
 * `refund` is not a cancellation.
 *
 * A cancel stops an order that has not been paid; a refund reverses one that
 * has, which is why it is a separate action rather than a second way to reach
 * `cancelled` — the money, the stock and the document behind it are all
 * different.
 */
export type OrderAction = 'confirm' | 'mark_ready' | 'complete' | 'cancel' | 'refund';

/** status → the actions that may legally be taken from it. */
const TRANSITIONS: Record<OrderStatus, Partial<Record<OrderAction, OrderStatus>>> = {
  pending: { confirm: 'confirmed', cancel: 'cancelled' },
  confirmed: { mark_ready: 'ready_for_pickup', cancel: 'cancelled' },
  ready_for_pickup: { complete: 'completed', cancel: 'cancelled' },
  completed: { refund: 'refunded' },
  cancelled: {},
  refunded: {},
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
 * The status as the shop says it out loud.
 *
 * Eight error messages across the order, refund, receipt and call-board paths used to
 * answer "Order 8f2c is cancelled and can no longer be confirmed", which put two
 * English enum values in front of whoever was standing at the till — `cancelled`,
 * `ready_for_pickup` — neither of which means anything to the person who has to decide
 * what to do next. The machine half was never lost: each of those errors carries a
 * stable `code` (`INVALID_TRANSITION`, `ORDER_NOT_COMPLETED`), so this map is only
 * ever the sentence, never the discriminator.
 *
 * Lives beside the transition table rather than in a component because a refusal is
 * raised in the domain layer and read on every screen; the board's column titles are
 * a separate thing and deliberately read in lifecycle order ("1 · รอยืนยัน") rather
 * than repeating these.
 */
const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'รอยืนยัน',
  confirmed: 'ยืนยันแล้ว กำลังเตรียม',
  ready_for_pickup: 'พร้อมรับแล้ว',
  completed: 'ปิดบิลแล้ว',
  cancelled: 'ยกเลิกแล้ว',
  refunded: 'คืนเงินแล้ว',
};

/** What a person at the counter is told this order's status is. */
export function orderStatusLabel(status: OrderStatus): string {
  return ORDER_STATUS_LABELS[status];
}

/**
 * True when the order is still claiming stock in `products.reserved_qty`.
 *
 * Phases 1–3 hold a reservation; completion converts it into a real sale and
 * cancellation gives it back.
 *
 * This used to be `!isTerminal(status)`, which was the same thing until refunds
 * existed — and is now wrong in a way worth stating, because it is the reason
 * this is written out longhand. `completed` is no longer terminal (it can be
 * refunded), while a completed or refunded sale holds *no* reservation: the units
 * left `reserved_qty` when the bill was settled, and a refund puts them back into
 * `stock_qty` through `returnRefundedStock`. Deriving one fact from the other
 * would silently claim that a paid sale is still holding somebody's pre-order.
 */
export function holdsReservedStock(status: OrderStatus): boolean {
  return status === 'pending' || status === 'confirmed' || status === 'ready_for_pickup';
}
