/**
 * The handoff a finished LINE consent leaves for the phone step (ADR 0030 §1,
 * amended).
 *
 * The id-token door holds a LINE id token in the browser, because LIFF handed it
 * one. The **redirect** flow cannot: LINE answers our callback with a one-time code
 * and the id token comes back to *this server*, over the channel secret. So when a
 * customer who has never bound LINE walks the front door, the proof that the
 * subject is genuinely LINE's exists only here — and the screen that collects a
 * phone, in the browser, needs it back.
 *
 * This token is that handoff. Three properties, each one a decision:
 *
 *   * **It names a LINE subject, not a user.** Holding it signs nobody in and
 *     touches no row: the phone step still has to consume an OTP challenge before
 *     anything is written (`line-identity.ts`). The strongest thing it can do is
 *     make the *binding* path ask for a code.
 *   * **It is short-lived and httpOnly.** Ten minutes is one phone number typed and
 *     one code received; a long-lived copy in a browser is a standing invitation to
 *     attach somebody's LINE account to a number somebody else proves.
 *   * **It has its own audience.** Signed with the same `AUTH_SECRET` as every
 *     other family here — the state, the session, the pickup code, the receipt link
 *     — so the audience is the only thing that tells them apart, which is the rule
 *     the security audit wrote into `session-token.ts` for all of them.
 *
 * The cookie itself is set by the two routes that use it: this module owns what the
 * handoff *is*, and `next/headers` stays out of it so the whole thing is testable
 * without a Next runtime — the same split `password.ts` records for the same reason.
 */
import { SignJWT, jwtVerify } from 'jose';

import { DomainError } from './errors';
import { authSecretKey } from './session-token';

const PENDING_ISSUER = 'pos-realtime';
const PENDING_AUDIENCE = 'line-pending';

/** The cookie the handoff rides in. Deliberately not the session's name. */
export const LINE_PENDING_COOKIE = 'pos_line_pending';

/**
 * Ten minutes, and the number is bounded from both sides: long enough to type a
 * number, receive a code and type it — the two slowest things a person does here —
 * and short enough that a handoff left open on a shared phone is worthless by the
 * time anybody finds it.
 */
export const LINE_PENDING_TTL_SECONDS = 10 * 60;

/**
 * Raised when a handoff is absent, tampered, or too old.
 *
 * A `DomainError` (422) so the customer is told to start again in their own
 * language, rather than `withApi` turning a stale handoff into "something went
 * wrong on our side" — the class of mistake `pickup-token.ts` records at length.
 */
export class LinePendingError extends DomainError {
  constructor(message = 'การยืนยัน LINE หมดอายุแล้ว — กรุณากดเข้าสู่ระบบด้วย LINE อีกครั้ง') {
    super(message, 'LINE_PENDING_EXPIRED', 422);
  }
}

/** A proved LINE identity waiting for a phone number. */
export interface LinePendingIdentity {
  /** LINE's stable per-user id — what `users.line_subject` will hold. */
  subject: string;
  /** What the LINE profile names them, for the form that collects the phone. */
  displayName: string | null;
  /**
   * The address the LINE profile carries, when the channel asks for one.
   *
   * Carried so that a customer created through this path gets the same row the id-token
   * path would create — it is stored at signup and is never trusted for *linking*
   * (ADR 0030 §5), which is the distinction that makes carrying it safe.
   */
  email: string | null;
}

/**
 * Signs the handoff.
 *
 * `ttlSeconds` exists for the expiry test, not for callers: a window that can only
 * be checked by waiting ten minutes is a window nobody checks.
 */
export async function createLinePendingToken(input: {
  subject: string;
  displayName: string | null;
  email: string | null;
  ttlSeconds?: number;
}): Promise<string> {
  return new SignJWT({ name: input.displayName, email: input.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.subject)
    .setIssuedAt()
    .setIssuer(PENDING_ISSUER)
    .setAudience(PENDING_AUDIENCE)
    .setExpirationTime(`${input.ttlSeconds ?? LINE_PENDING_TTL_SECONDS}s`)
    .sign(authSecretKey());
}

/**
 * The identity a handoff names — see `LinePendingError` for the failure.
 *
 * Every failure is the same failure. An expired token, a tampered one, a session
 * token and a piece of junk are one answer to a customer: start again. Telling them
 * apart would only help somebody probing what this endpoint accepts.
 */
export async function verifyLinePendingToken(token: string): Promise<LinePendingIdentity> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), {
      issuer: PENDING_ISSUER,
      audience: PENDING_AUDIENCE,
    });

    const { sub, name, email } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new LinePendingError();
    }

    return {
      subject: sub,
      displayName: typeof name === 'string' ? name : null,
      email: typeof email === 'string' ? email : null,
    };
  } catch (error) {
    if (error instanceof LinePendingError) {
      throw error;
    }
    throw new LinePendingError();
  }
}

/**
 * The attributes the handoff cookie is written with.
 *
 * `sameSite: 'lax'` and not `'strict'`: LINE sends the customer back with a
 * top-level GET from another origin, and a strict cookie is not sent with one — the
 * handoff would disappear at exactly the moment it is needed. `lax` is the same
 * setting the session cookie uses, for the same class of reason.
 *
 * `httpOnly`, because no script in this application has any use for it, and a
 * pending identity is a thing worth stealing.
 */
export function linePendingCookieOptions(isProduction: boolean): {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: LINE_PENDING_TTL_SECONDS,
  };
}
