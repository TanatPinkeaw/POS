/**
 * What is happening to the *goods* of a paid order (ADR 0018).
 *
 * Deliberately not `OrderStatus`, and the separation is the whole point. `status`
 * is the lifecycle of an order's money and stock: a walk-in sale is `completed`
 * the instant it is paid, and every report, every refund and every refusal reads
 * that column. A drink that is paid for and not yet made is finished business by
 * that definition and unfinished work by the shop's own — so the two are separate
 * columns running separate machines, and the money machine is not bent to make a
 * screen at the bar work.
 *
 *   preparing ──mark_ready──> ready ──collect──> collected
 *        │                     │
 *        └──────── collect ────┘
 *
 * `preparing → collected` is legal on purpose. A shop that hands the cup over
 * without tapping anything in between is doing the normal thing on a busy
 * afternoon, and a machine that refused it would leave that bill on the board for
 * the rest of the day — on a screen the customers are reading. `collected` is
 * terminal: the number is retired, and re-tapping a ticket is not a state anybody
 * needs.
 */
export type FulfilmentState = 'preparing' | 'ready' | 'collected';

export type FulfilmentAction = 'mark_ready' | 'collect';

/** state → the actions that may legally be taken from it. */
const TRANSITIONS: Record<FulfilmentState, Partial<Record<FulfilmentAction, FulfilmentState>>> = {
  preparing: { mark_ready: 'ready', collect: 'collected' },
  ready: { collect: 'collected' },
  collected: {},
};

/** True when `action` is a legal move out of `from`. */
export function canFulfil(from: FulfilmentState, action: FulfilmentAction): boolean {
  return TRANSITIONS[from][action] !== undefined;
}

/**
 * The state reached by taking `action` from `from`.
 *
 * Throws rather than returning a sentinel, like `nextStatus`: reaching here with an
 * illegal move means a guard was skipped, which is a bug worth hearing about.
 */
export function nextFulfilment(from: FulfilmentState, action: FulfilmentAction): FulfilmentState {
  const to = TRANSITIONS[from][action];
  if (to === undefined) {
    throw new Error(`Illegal fulfilment transition: cannot ${action} goods that are "${from}"`);
  }
  return to;
}

/**
 * True while a ticket belongs on the board — the state a customer is still
 * waiting through.
 *
 * Exported so the two readers of the board (the bar's screen and the orders
 * query behind it) agree on what "on the board" means; a screen that drew a
 * collected ticket, or a query that hid a preparing one, would each be a second
 * definition of the same word.
 */
export function isWaiting(state: FulfilmentState): boolean {
  return state === 'preparing' || state === 'ready';
}

/** Every state, in the order a ticket moves through them. */
export const FULFILMENT_STATES: readonly FulfilmentState[] = ['preparing', 'ready', 'collected'];

/** True when `value` is one of this machine's states — for reading rows back. */
export function isFulfilmentState(value: string): value is FulfilmentState {
  return (FULFILMENT_STATES as readonly string[]).includes(value);
}
