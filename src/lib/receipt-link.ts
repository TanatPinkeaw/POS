/**
 * The signed link a customer carries a receipt image away on (ADR 0021 §3).
 *
 * The problem it solves is the walk-in: a customer who never registered still
 * bought something and still wants the document, and there is no account to file
 * it under. The answer is the same discipline as the pickup code
 * (`src/lib/pickup-token.ts`), applied to a document instead of a parcel:
 *
 *   * **It names exactly one order.** The order id is the token's subject, and the
 *     endpoint resolves the receipt from that id alone — so a link can only ever
 *     serve the sale it was issued for.
 *   * **It has its own audience.** The audience is `receipt-download`, distinct
 *     from a session and from a pickup code, so a signed-in customer's session
 *     cannot be presented as a receipt link (nor the reverse). That is asserted in
 *     the tests rather than assumed.
 *   * **It expires, and no later than the order's own window.** Two clocks bound a
 *     link: the short life of one issued link (minutes — it is a bearer credential,
 *     and short is how the pickup code is treated) and the one-month access window
 *     from `receipt-access.ts`. The expiry is the earlier of them, so a link can
 *     never outlive the window it was granted under.
 *   * **It is reissued, not reused.** Every issue carries a fresh `jti`, so two
 *     links for one order are different tokens; a caller asks for a new link rather
 *     than keeping an old one alive. A spent (expired) link simply stops verifying.
 *
 * It is *not* proof of identity: whoever holds the link can download the receipt,
 * which is exactly why it is short-lived and scoped to one order.
 */
import { SignJWT, jwtVerify } from 'jose';

import { DomainError } from './errors';
import { optionalNumberEnv } from './env';
import { receiptAccessDays, receiptAccessUntil } from './receipt-access';
import { authSecretKey } from './session-token';

const RECEIPT_ISSUER = 'pos-realtime';
const RECEIPT_AUDIENCE = 'receipt-download';

/**
 * Raised when a presented link is not a receipt link we issued, for any reason.
 *
 * One answer covers a tampered signature, a wrong audience, an expired token and a
 * piece of foreign junk — telling them apart would only help somebody probing which
 * links are real. A `DomainError` (422), so `withApi` returns words a person can act
 * on ("ask the counter for a new link") rather than a 500 for a stale link nobody's
 * side got wrong.
 */
export class InvalidReceiptLinkError extends DomainError {
  constructor(message = 'Invalid or expired receipt link') {
    super(message, 'INVALID_RECEIPT_LINK', 422);
  }
}

/**
 * Raised when a link is valid but the order it names is older than the window.
 *
 * Distinct from `InvalidReceiptLinkError` on purpose: the link itself is fine, the
 * *access* has closed, and a shop should be able to tell a customer "that bill is
 * more than a month old" rather than "this link is broken". 410 Gone is that
 * distinction, and it is also what the counter's mint route answers once a sale has
 * aged out.
 */
export class ReceiptWindowClosedError extends DomainError {
  constructor(message = 'This receipt is older than the download window') {
    super(message, 'RECEIPT_WINDOW_CLOSED', 410);
  }
}

/** How long one issued link lives, in minutes — the bearer-credential half. */
export function receiptLinkTtlMinutes(): number {
  return optionalNumberEnv('RECEIPT_LINK_TTL_MINUTES', 60);
}

/** Signs a link for one order, expiring at `expiresAt`. */
export async function createReceiptToken(input: {
  orderId: string;
  expiresAt: Date;
}): Promise<string> {
  return new SignJWT({ scope: 'receipt' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.orderId)
    // A fresh id per issue is what makes "reissue rather than reuse" true: two
    // links for one order are never the same token.
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setIssuer(RECEIPT_ISSUER)
    .setAudience(RECEIPT_AUDIENCE)
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1000))
    .sign(authSecretKey());
}

/**
 * The order a presented link names — see `InvalidReceiptLinkError` for the status.
 *
 * This proves only that *we* signed a link naming this order and that it has not
 * expired. Whether the order still falls inside the one-month window is a separate
 * question, asked by the endpoint against the order's own sale instant, because the
 * window can close while a link is still technically unexpired.
 */
export async function verifyReceiptToken(token: string): Promise<{ orderId: string }> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), {
      issuer: RECEIPT_ISSUER,
      audience: RECEIPT_AUDIENCE,
    });

    const { sub, scope } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || sub.length === 0 || scope !== 'receipt') {
      throw new InvalidReceiptLinkError();
    }

    return { orderId: sub };
  } catch (error) {
    if (error instanceof InvalidReceiptLinkError) {
      throw error;
    }
    throw new InvalidReceiptLinkError();
  }
}

/**
 * When a link issued at `now` should stop working: the sooner of its own short life
 * and the moment the window closes. Null when the window has already closed, so
 * there is no link to mint at all.
 */
export function receiptLinkExpiry(input: {
  soldAt: Date;
  now?: Date;
  ttlMinutes?: number;
  days?: number;
}): Date | null {
  const now = input.now ?? new Date();
  const until = receiptAccessUntil(input.soldAt, input.days ?? receiptAccessDays());
  if (now.getTime() >= until.getTime()) {
    return null;
  }

  const shortLived = new Date(now.getTime() + (input.ttlMinutes ?? receiptLinkTtlMinutes()) * 60_000);
  return shortLived.getTime() < until.getTime() ? shortLived : until;
}

/**
 * A link for one order, or null when its window has closed.
 *
 * Null rather than a throw because "there is no file to offer" is a normal state a
 * screen renders (ADR 0021 §2) — the order stays visible while the download is
 * withheld. A caller that has to *answer* a request (the mint route) turns the null
 * into `ReceiptWindowClosedError`.
 */
export async function createReceiptLink(input: {
  orderId: string;
  soldAt: Date;
  now?: Date;
}): Promise<string | null> {
  const expiresAt = receiptLinkExpiry(input);
  if (expiresAt === null) {
    return null;
  }
  return createReceiptToken({ orderId: input.orderId, expiresAt });
}
