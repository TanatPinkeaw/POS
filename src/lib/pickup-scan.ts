/**
 * What just arrived in the handover box — SRS §3.
 *
 * The counter has one field and three kinds of answer. A scanner types a signed
 * code, the customer reads out a four-digit PIN, and the customer who lost the slip
 * recites a phone number. The screen cannot ask which one it is: by the time the
 * question is worth asking, the cashier has already pressed Enter.
 *
 * So the shape decides, and this module holds that decision on its own — no `jose`,
 * no database, nothing that would drag a JWT library into the till's client bundle
 * merely to run a regex. `src/lib/pickup-token.ts` verifies; this only routes.
 *
 * It is deliberately a *shape* test and not a verification. Trying to verify a term
 * to find out what it is would let a mistyped phone number come back as "that code
 * is not valid", and a cashier who is told a code is invalid when they typed a phone
 * number has been sent looking in the wrong place.
 */

/** A four-digit pickup PIN: `order.pickup_pin`, read aloud. */
export const PIN_PATTERN = /^\d{4}$/;

/**
 * A compact JWS: three dot-separated base64url segments, which is what
 * `createPickupToken` produces.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Whether a scanned term looks like a pickup code rather than a PIN or phone number. */
export function looksLikePickupToken(term: string): boolean {
  return TOKEN_PATTERN.test(term.trim());
}

/**
 * The lookup field a scanned or typed term belongs in.
 *
 * Returned as the request body the lookup route already accepts, rather than as a
 * name the caller has to switch on: the counter's whole job is to get this right
 * once, and every extra place that maps a term to a field is a place for the two to
 * disagree.
 *
 * Phone numbers are the fallthrough because their shape is the loosest — ten digits,
 * with or without punctuation, sometimes with a country code — and a wrong guess
 * there produces the mildest failure: "no order found", which is also true.
 */
export function handoverLookupBody(
  term: string,
): { pin: string } | { phone: string } | { pickupToken: string } {
  const trimmed = term.trim();
  if (PIN_PATTERN.test(trimmed)) {
    return { pin: trimmed };
  }
  if (looksLikePickupToken(trimmed)) {
    return { pickupToken: trimmed };
  }
  return { phone: trimmed };
}
