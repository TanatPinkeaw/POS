/**
 * The number a customer is called by (ADR 0017).
 *
 * Kept pure and on its own, the way the money rules are, for one reason: three
 * places have to agree on what a call number looks like — the till's receipt, the
 * shop's own reprint of that receipt, and (in the round that follows) the screen
 * customers read it off. A second implementation of "pad it to three digits" is
 * how a customer ends up looking for `7` on a board that says `007`.
 *
 * What is *not* here: the day rollover. That is a property of the shop row's
 * counter, decided in the same statement that bumps it — see `allocateQueueNumber`.
 * The stored value is the plain integer; the printing is this.
 */

/**
 * Digits a call number is padded to.
 *
 * Three, because that is what a ticket looks like: `037` reads as a number to call
 * out, `37` reads as a count of something. Padding is not truncation — a shop that
 * serves its thousandth customer in a day gets `1000`, four digits and all, because
 * a number that wraps is a number that gets called twice.
 */
export const QUEUE_NUMBER_WIDTH = 3;

/** The stored integer as it is printed and called. */
export function formatQueueNumber(value: number): string {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`A call number is a positive whole number; got ${value}`);
  }
  return String(value).padStart(QUEUE_NUMBER_WIDTH, '0');
}
