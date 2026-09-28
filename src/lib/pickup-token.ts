/**
 * The QR a customer shows at the counter — SRS §3 asks for a PIN *and* a code.
 *
 * The PIN is four digits and deliberately so: it is read aloud, typed by a
 * cashier, and short enough to survive a phone call. That is also why it cannot be
 * the only way in — four digits is a guessable secret, and a shop with five parcels
 * waiting has five of them live at once. So the second credential is this: a signed
 * token that names exactly one order, carries its own expiry, and cannot be
 * guessed, because it is not a secret at all until the shop signs it.
 *
 * Three properties, and each one is a decision:
 *
 *   * **It expires when the hold does.** The token's `exp` is the order's own
 *     `pickup_expires_at`, so there is no second clock to keep in step and a QR
 *     screenshotted last week is worthless. A token with no expiry would be a
 *     permanent key to somebody's parcel.
 *   * **It names one order.** The order id is the token's subject, and resolving it
 *     goes through the same "is this order waiting for collection" filter the PIN
 *     does — so a token can never collect something it was not issued for.
 *   * **It is not a session.** Its own issuer and audience mean a signed-in
 *     customer's session token cannot be presented as a pickup code, which is the
 *     mistake that would turn every logged-in member into a parcel collector. That
 *     is asserted in the tests rather than assumed.
 *
 * What it is *not* is proof of identity: whoever holds the code can collect the
 * parcel, which is why it is shown on the customer's own order screen and printed
 * nowhere else.
 */
import { SignJWT, jwtVerify } from 'jose';

import { DomainError } from './errors';
import { authSecretKey } from './session-token';

const PICKUP_ISSUER = 'pos-realtime';
const PICKUP_AUDIENCE = 'pickup-handover';

/**
 * Raised when a scanned code is not a pickup token we issued, for any reason.
 *
 * A `DomainError`, so `withApi` turns it into a 422 the counter can act on. It was
 * an ordinary `Error` until a shower of them showed up as 500s: an expired code, a
 * mistyped character and a piece of foreign junk all reached the cashier as
 * "something went wrong on our side", which is both alarming and useless — the
 * customer's QR was stale, and nothing on our side had gone wrong at all.
 */
export class InvalidPickupTokenError extends DomainError {
  constructor(message = 'Invalid or expired pickup code') {
    super(message, 'INVALID_PICKUP_CODE', 422);
  }
}

/**
 * Signs a code for one order, expiring when the order's hold does.
 *
 * Returns a token even when the hold has already passed — the signature is not the
 * place to refuse a stale parcel, and a token that verifies but names an order that
 * is no longer waiting is refused by the lookup, which is where that fact lives.
 */
export async function createPickupToken(input: {
  orderId: string;
  expiresAt: Date;
}): Promise<string> {
  return new SignJWT({ scope: 'pickup' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.orderId)
    .setIssuedAt()
    .setIssuer(PICKUP_ISSUER)
    .setAudience(PICKUP_AUDIENCE)
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1000))
    .sign(authSecretKey());
}

/**
 * The order a scanned code names — see `InvalidPickupTokenError` for the status.
 *
 * Every failure is the same failure. A tampered signature, a wrong audience, an
 * expired token and a piece of the wrong kind of junk are one answer to a cashier
 * — "that code is not valid" — and telling them apart would only help somebody
 * probing which codes are real.
 */
export async function verifyPickupToken(token: string): Promise<{ orderId: string }> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), {
      issuer: PICKUP_ISSUER,
      audience: PICKUP_AUDIENCE,
    });

    const { sub, scope } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || sub.length === 0 || scope !== 'pickup') {
      throw new InvalidPickupTokenError();
    }

    return { orderId: sub };
  } catch (error) {
    if (error instanceof InvalidPickupTokenError) {
      throw error;
    }
    throw new InvalidPickupTokenError();
  }
}
