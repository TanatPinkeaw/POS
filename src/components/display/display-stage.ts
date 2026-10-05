/**
 * Which single stage the customer screen is on.
 *
 * The screen has five things it can show, and for two rounds it decided each one
 * with its own `!paying && !selling && …` condition spread across five JSX
 * branches. Those conditions were almost mutually exclusive, and "almost" is
 * what broke: a bill snapshot left on the display suppressed the receipt QR a
 * cashier had just pushed, and with the bill cleared the receipt then drew on
 * top of the idle welcome. Neither was a data problem — the events arrived — so
 * nothing but looking at a real paired screen would have found them.
 *
 * One function now answers the question, so the invariant is "exactly one stage"
 * by construction, and the precedence below is a thing a test can hold rather
 * than a property of five conditions that have to be kept in step by hand.
 *
 * The order is deliberate:
 *
 *   1. **paying** — a live QR is money in flight; nothing outranks it.
 *   2. **receipt** — an explicit act by the cashier ("ขึ้นจอลูกค้า"). It has to
 *      beat a leftover bill, because the cashier asked for it *now* and a stale
 *      snapshot is not a reason to ignore them. Bounded by the dialog being
 *      open, so it cannot drift onto the next customer.
 *   3. **selling** — the bill being rung up.
 *   4. **ready** — the collection board.
 *   5. **idle** — the welcome, when there is genuinely nothing else.
 */
export type DisplayStageName = 'paying' | 'receipt' | 'selling' | 'ready' | 'idle';

export interface DisplayStageInput {
  /** A payment intent is live. */
  hasPaymentQr: boolean;
  /** A receipt link has been pushed to this screen and not yet cleared. */
  hasReceipt: boolean;
  /** How many lines the last cart snapshot carried. */
  lineCount: number;
  /** There is at least one called number or waiting pre-order. */
  hasReadyBoard: boolean;
}

export function displayStage(input: DisplayStageInput): DisplayStageName {
  if (input.hasPaymentQr) {
    return 'paying';
  }
  if (input.hasReceipt) {
    return 'receipt';
  }
  if (input.lineCount > 0) {
    return 'selling';
  }
  if (input.hasReadyBoard) {
    return 'ready';
  }
  return 'idle';
}
