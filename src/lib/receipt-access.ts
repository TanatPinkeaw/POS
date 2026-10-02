/**
 * How long a receipt's *image* stays downloadable (ADR 0021 §2).
 *
 * This is an access rule, not a retention rule. The order row is kept
 * indefinitely — it is a tax document, and the gapless receipt series may not have
 * a hole — so nothing is ever deleted when the window closes. Only the file stops
 * being offered, and the order stays visible in the customer's history.
 *
 * Written as a pure function of two instants — when it was sold, when it is being
 * asked for — because that is the only way to test the boundary without a clock, a
 * database or a browser, and because the same answer has to hold for the counter's
 * screen, the portal and the signed link.
 *
 * **"The last month" is read as a fixed count of days, not a calendar month.** A
 * calendar month has no single length (28 to 31 days), so "one month later" would
 * need clamping rules that turn over differently for a sale on the 31st, and the
 * window's end would not be a single testable instant. A rolling stretch of days is
 * what a customer means by "the last month" anyway, and thirty is the same number
 * whichever month the sale happened in. The count is configurable
 * (`RECEIPT_ACCESS_DAYS`) because a shop's own retention posture may differ from
 * the default.
 *
 * Pure: no Prisma, no clock of its own, no import that reads a file.
 */
import { MS_PER_DAY } from './bangkok-time';
import { optionalNumberEnv } from './env';

/** Days a customer may still download a receipt image before the window closes. */
export function receiptAccessDays(): number {
  return optionalNumberEnv('RECEIPT_ACCESS_DAYS', 30);
}

/** The instant the download window closes: `days` after the sale. */
export function receiptAccessUntil(soldAt: Date, days: number = receiptAccessDays()): Date {
  return new Date(soldAt.getTime() + days * MS_PER_DAY);
}

/**
 * Whether the image may still be downloaded at `now`.
 *
 * Half-open on purpose — `now < until` — so the window closes exactly at the
 * boundary rather than a millisecond later, and a bill is never served one tick
 * into a month it was not promised for. The boundary itself is closed: the instant
 * the window ends is no longer inside it.
 */
export function receiptWithinAccessWindow(
  soldAt: Date,
  now: Date = new Date(),
  days: number = receiptAccessDays(),
): boolean {
  return now.getTime() < receiptAccessUntil(soldAt, days).getTime();
}
