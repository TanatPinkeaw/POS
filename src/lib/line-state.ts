/**
 * The state a LINE door mints, and the intent it carries (ADR 0030 §1, amended).
 *
 * The state is the CSRF control on the callback: a value this deployment signed, handed
 * to LINE and returned by the browser, so a callback that carries one is a callback this
 * browser actually started. It is a signed JWT rather than a session row — five minutes,
 * no storage, and `jose` (already a dependency) verifies it on the way back.
 *
 * Three claims, and the third is the one that was missing the *other* way round. The
 * signature alone proves nothing about which family a token belongs to: every token here
 * is signed with the one `AUTH_SECRET`, so a session token pasted into this URL verifies
 * exactly as well as a real state unless the verifier pins its own issuer and audience —
 * the rule the security audit wrote into `session-token.ts` after demonstrating the same
 * confusion between a pickup code and a session. The `purpose` claim then says *which door*
 * minted it, because the two doors mean opposite things: one signs a customer in, the
 * other writes a binding onto the session that is already there. Without it, a state
 * minted for the account page could be replayed at the front door (or the reverse) and the
 * callback would happily do the other thing — the exact confusion a `state` exists to stop.
 */
import { SignJWT, jwtVerify } from 'jose';

import { DomainError } from './errors';
import { type LineIntent, intentForPurpose, purposeForIntent } from './line-door';
import { authSecretKey } from './session-token';

const STATE_ISSUER = 'pos-realtime';
const STATE_AUDIENCE = 'line-state';

/** How long a state may live: one walk through LINE's consent screens. */
export const LINE_STATE_TTL_SECONDS = 300;

/**
 * Raised when a returned state is absent, tampered with, expired, or not a state at all.
 *
 * A `DomainError` rather than an ordinary `Error`, so the customer's browser gets a
 * redirect with a Thai sentence instead of the 500 `withApi` would otherwise produce.
 */
export class InvalidLineStateError extends DomainError {
  constructor(message = 'การยืนยันจาก LINE ไม่ถูกต้องหรือหมดอายุ — กรุณาเข้าสู่ระบบด้วย LINE ใหม่อีกครั้ง') {
    super(message, 'INVALID_LINE_STATE', 422);
  }
}

/** Signs a state that means one thing: sign this customer in, or bind this session. */
export async function createLineState(intent: LineIntent): Promise<string> {
  return new SignJWT({ purpose: purposeForIntent(intent) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(STATE_ISSUER)
    .setAudience(STATE_AUDIENCE)
    .setExpirationTime(`${LINE_STATE_TTL_SECONDS}s`)
    .sign(authSecretKey());
}

/**
 * The intent a state claims — see `InvalidLineStateError` for every failure.
 *
 * One answer covers an expired state, a tampered one, a session token and a piece of
 * junk, and that is deliberate twice over: they are all "start again" to the person
 * holding the browser, and telling them apart would only help somebody probing what this
 * deployment accepts.
 */
export async function verifyLineState(token: string): Promise<LineIntent> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), {
      issuer: STATE_ISSUER,
      audience: STATE_AUDIENCE,
    });

    const intent = intentForPurpose(payload.purpose);
    if (intent === null) {
      throw new InvalidLineStateError();
    }
    return intent;
  } catch (error) {
    if (error instanceof InvalidLineStateError) {
      throw error;
    }
    throw new InvalidLineStateError();
  }
}
