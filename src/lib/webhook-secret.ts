/**
 * Comparing a shared secret without leaking it.
 *
 * Two endpoints are open to machines with no session: confirming that a transfer
 * arrived, and recording a notification that arrived. Both are the same trust
 * boundary — whoever holds the secret can mark money as received — so they compare
 * it the same way, in one place, and that place is here rather than a copy in each
 * route.
 *
 * Two details matter:
 *
 *   * **Both sides are hashed before they are compared.** `timingSafeEqual`
 *     throws on buffers of different lengths, and a length check before it would
 *     itself leak the secret's length. Digesting both to 32 bytes makes every
 *     comparison the same shape.
 *   * **Missing configuration fails closed.** An unset secret must refuse
 *     everything, because the alternative — treating "no secret configured" as
 *     "no secret required" — turns a shop that never set one into an open door.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export function secretMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) {
    return false;
  }

  const left = createHash('sha256').update(provided, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** The header a bank bridge or payment provider presents its secret in. */
export const PAYMENT_SECRET_HEADER = 'x-payment-secret';

/** Whether this request came from a machine that holds the shop's secret. */
export function requestHasPaymentSecret(request: Request): boolean {
  return secretMatches(request.headers.get(PAYMENT_SECRET_HEADER), process.env.PAYMENT_WEBHOOK_SECRET);
}
