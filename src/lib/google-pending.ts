/**
 * The handoff a finished Google sign-in leaves for the phone step (ADR 0020 §1,
 * amended).
 *
 * The popup flow hands the browser an id token, so the screen that collects a first
 * customer's phone number can post it back. **The redirect flow cannot**: Google POSTs
 * the credential to this server, and the browser's own copy never exists. That is fine
 * while the Google account already resolves to a customer — the landing starts the
 * session and the browser is done — but a first sign-in still has to reach a screen that
 * collects a number, and the proof that this Google account is genuinely Google's exists
 * only on the server by then.
 *
 * This token is that handoff. Three properties, each one a decision, and they are
 * `line-pending.ts`'s for the same reasons:
 *
 *   * **It names a Google subject, not a user.** Holding it signs nobody in and touches
 *     no row: the phone step still posts a phone, and `identity.ts` is what decides
 *     whether the pair may become a customer. The strongest thing it can do is make the
 *     signup path skip the token verification it would otherwise do — with a subject
 *     Google itself signed for this deployment's client id.
 *   * **It is short-lived and httpOnly.** Ten minutes is one phone number typed and one
 *     notice read; a long-lived copy in a browser is a standing invitation to attach
 *     somebody's Google account to a number somebody else types.
 *   * **It has its own audience.** Signed with the same `AUTH_SECRET` as the session, the
 *     pickup code, the receipt link, the LINE state and the LINE handoff — so the audience
 *     is the only thing that tells these families apart, which is the rule the security
 *     audit wrote into `session-token.ts` for all of them. A family without its own would
 *     be the same confusion the audit demonstrated.
 *
 * The id token itself is deliberately **not** what rides in the cookie, even though it
 * would fit: a full credential in a browser, when the only thing needed afterwards is
 * "which Google account was verified here", is a worse thing to leave lying in a jar that
 * every script on the shop's own origin shares. `line-pending.ts` rejected the same
 * shortcut for the same reason.
 *
 * The cookie itself is set by the one route that uses it: this module owns what the
 * handoff *is*, and `next/headers` stays out of it so the whole thing is testable without
 * a Next runtime — the split `password.ts` records for the same reason.
 */
import { SignJWT, jwtVerify } from 'jose';

import { DomainError } from './errors';
import { authSecretKey } from './session-token';

const PENDING_ISSUER = 'pos-realtime';
const PENDING_AUDIENCE = 'google-pending';

/** The cookie the handoff rides in. Deliberately not the session's name, nor LINE's. */
export const GOOGLE_PENDING_COOKIE = 'pos_google_pending';

/**
 * Ten minutes, bounded from both sides like the LINE handoff: long enough to type a
 * number, read the notice and press the button, and short enough that one left open on a
 * shared phone is worthless by the time anybody finds it.
 */
export const GOOGLE_PENDING_TTL_SECONDS = 10 * 60;

/**
 * Raised when a handoff is absent, tampered with, or too old.
 *
 * A `DomainError` (422) so the customer is told to start again in their own language,
 * rather than `withApi` turning a stale handoff into "something went wrong on our side" —
 * the class of mistake `pickup-token.ts` records at length.
 */
export class GooglePendingError extends DomainError {
  constructor(message = 'การยืนยัน Google หมดอายุแล้ว — กรุณากดปุ่มเข้าสู่ระบบด้วย Google อีกครั้ง') {
    super(message, 'GOOGLE_PENDING_EXPIRED', 422);
  }
}

/** A proved Google identity waiting for a phone number. */
export interface GooglePendingIdentity {
  /** Google's stable per-user id — what `users.google_subject` will hold. */
  subject: string;
  /** What the Google profile names them, for the form that collects the phone. */
  displayName: string | null;
  /** The address the Google profile carries, when it carries one. */
  email: string | null;
  /**
   * Whether Google asserted the address at the moment the landing verified the id token.
   *
   * Carried rather than assumed: the landing *is* the verification, and a handoff that
   * invented `false` here would be the one place in this flow that states a fact it did
   * not check. Nothing in the signup path decides on it today — the address is stored and
   * never trusted for *linking* (ADR 0020 §5) — but the identity that reaches
   * `identity.ts` should be the one Google signed, not a lossy copy of it.
   */
  emailVerified: boolean;
}

/**
 * Signs the handoff.
 *
 * `ttlSeconds` exists for the expiry test, not for callers: a window that can only be
 * checked by waiting ten minutes is a window nobody checks.
 */
export async function createGooglePendingToken(input: {
  subject: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  ttlSeconds?: number;
}): Promise<string> {
  return new SignJWT({
    name: input.displayName,
    email: input.email,
    email_verified: input.emailVerified,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(input.subject)
    .setIssuedAt()
    .setIssuer(PENDING_ISSUER)
    .setAudience(PENDING_AUDIENCE)
    .setExpirationTime(`${input.ttlSeconds ?? GOOGLE_PENDING_TTL_SECONDS}s`)
    .sign(authSecretKey());
}

/**
 * The identity a handoff names — see `GooglePendingError` for the failure.
 *
 * Every failure is the same failure. An expired token, a tampered one, a session token and
 * a piece of junk are one answer to a customer: start again. Telling them apart would only
 * help somebody probing what this endpoint accepts.
 */
export async function verifyGooglePendingToken(token: string): Promise<GooglePendingIdentity> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), {
      issuer: PENDING_ISSUER,
      audience: PENDING_AUDIENCE,
    });

    const { sub, name, email, email_verified } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new GooglePendingError();
    }

    return {
      subject: sub,
      displayName: typeof name === 'string' ? name : null,
      email: typeof email === 'string' ? email : null,
      emailVerified: email_verified === true,
    };
  } catch (error) {
    if (error instanceof GooglePendingError) {
      throw error;
    }
    throw new GooglePendingError();
  }
}

/**
 * The attributes the handoff cookie is written with.
 *
 * `sameSite: 'lax'` and not `'strict'`, for the reason the LINE handoff records: the cookie
 * is written on a *cross-site* response — Google's form POST landing on this origin — and a
 * strict cookie would not be stored at all, so the phone step would find nothing waiting.
 * `lax` is also what the session cookie uses, so the two live side by side without one of
 * them surprising a reader.
 *
 * `httpOnly`, because no script in this application has any use for it, and a pending
 * identity is a thing worth stealing.
 */
export function googlePendingCookieOptions(isProduction: boolean): {
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
    maxAge: GOOGLE_PENDING_TTL_SECONDS,
  };
}
