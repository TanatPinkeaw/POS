/**
 * Which day a sale belongs to — ADR 0019 decision 4.
 *
 * A bill sold at 21:00 with no connection and synced at 08:12 the next morning is
 * **yesterday's takings**. `created_at` cannot answer that, because it is the moment the
 * server *learned* about the bill, and `completed_at` — which every report used to bucket
 * by — is a lifecycle timestamp that happens to equal the sale instant for a walk-in sale
 * and is something else again for a pre-order. So the instant a sale happened is its own
 * column (`orders.sold_at`) and this module is the one place that says what it means.
 *
 * Three things it owns, and the reason each is a name rather than an expression:
 *
 * 1. **`SALE_INSTANT_COLUMN`** — the column. Every day-bucketed read in this codebase
 *    goes through it, including the one raw query that buckets in SQL, so a later report
 *    cannot quietly pick `created_at` and file yesterday's evening under this morning.
 * 2. **`saleInstant`** — which instant to write. An ordinary sale happened now; a
 *    replayed one happened when the device says it did, and the device is the only
 *    witness. The one case it corrects is a device clock *ahead* of the server: a bill
 *    cannot have been sold in the future, and filing it there would put money into a day
 *    that has not finished.
 * 3. **`saleDay`** — the Bangkok day of that instant, which is what a shop means by
 *    "today". Never the server's local date: a process in another timezone would file the
 *    same bill under a different day.
 *
 * Pure, and deliberately small: this is a rule, not a module with a database.
 */
import { bangkokDateString } from './bangkok-time';

/**
 * The column a sale's own instant lives in, for callers that build SQL.
 *
 * A name rather than a string literal at each call site. The dashboard's sales-by-day
 * buckets in one raw query — because PostgreSQL does the day arithmetic in Bangkok — and
 * that is exactly the place a column name drifts away from the rest of the codebase
 * without a type checker noticing.
 */
export const SALE_INSTANT_COLUMN = 'sold_at';

export interface SaleInstant {
  /** The instant the sale is filed under. */
  readonly at: Date;
  /**
   * True when the device's instant was in the future and was moved back to the server's
   * now. The bill is still recorded — its goods are gone and its slip is printed — but
   * the caller discloses the correction rather than silently rewriting a fact.
   */
  readonly clamped: boolean;
}

/**
 * The instant to record for a sale.
 *
 * `deviceInstant` is present only for a bill replayed from a device's offline queue, and
 * it is trusted for the same reason the device's printed price is trusted: it is the only
 * witness to when the sale happened, and the alternative is filing a week of an outage
 * under the morning it ended.
 *
 * A device clock that runs **ahead** is the one case that is not trusted, and it is a
 * refusal to write a future date rather than a rule about clock accuracy: a sale dated
 * tomorrow appears in tomorrow's takings, and tomorrow's reconciliation has already
 * passed. Clamping to `now` keeps the bill in the present, which is wrong in the least
 * harmful direction, and the caller reports it.
 */
export function saleInstant(input: { now: Date; deviceInstant?: Date }): SaleInstant {
  const deviceInstant = input.deviceInstant;
  if (!deviceInstant) {
    return { at: input.now, clamped: false };
  }
  if (deviceInstant.getTime() > input.now.getTime()) {
    return { at: input.now, clamped: true };
  }
  return { at: deviceInstant, clamped: false };
}

/** The Bangkok calendar day a sale instant belongs to — `YYYY-MM-DD`. */
export function saleDay(at: Date): string {
  return bangkokDateString(at);
}

/**
 * The filter every day-bucketed read applies — on `sold_at`, and there is no other way to
 * write it.
 *
 * This exists as a function rather than as a `sold_at: { gte, lt }` written out at each
 * call site because the failure it prevents is silent and easy: `created_at` and
 * `completed_at` are *also* real columns of `orders`, so a report that reached for the
 * wrong one still type-checks and still returns sales. It just files them under the day the
 * server heard about them. Naming the column once means the next report cannot pick it.
 *
 * `toExclusive` is optional because a window that runs to "now" has no upper bound worth
 * stating — no sale can be in the future, which `saleInstant` is what guarantees.
 */
export function soldIn(range: { from: Date; toExclusive?: Date }): {
  sold_at: { gte: Date; lt?: Date };
} {
  return {
    sold_at: range.toExclusive ? { gte: range.from, lt: range.toExclusive } : { gte: range.from },
  };
}
