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
 *
 * The fourth claim is `retried`, and it is a *ceiling* rather than a fact about the
 * customer: it says this walk through LINE's screens is already the second one. LINE's
 * documented remedy for a phone whose auto login failed is to send the customer back to
 * the authorization URL with auto login switched off — which is one more callback that can
 * fail in exactly the same way, so the remedy needs a bound, and a bound that travels in
 * the signature rather than in a counter this deployment would have to store. Without it a
 * phone that fails twice would loop instead of reading the front door's sentence.
 */
import { SignJWT, jwtVerify } from 'jose';

import { DomainError } from './errors';
import { type LineIntent, intentForPurpose, purposeForIntent } from './line-door';
import { authSecretKey } from './session-token';

const STATE_ISSUER = 'pos-realtime';
const STATE_AUDIENCE = 'line-state';

/**
 * How long a state may live: a page left open, then one walk through LINE's screens.
 *
 * It used to be five minutes, which was exactly one walk — because the state was minted at
 * the moment the customer pressed the button. It is minted when the sign-in page is *painted*
 * now (a press reaches LINE's own address directly, so nothing of ours runs in between), and
 * the life has to start there: a phone set down on the sign-in screen for ten minutes and
 * then picked up must not be a walk that ends in "การยืนยันหมดอายุ". Fifteen minutes covers a
 * customer finding their LINE password, which is the longest part of the walk and not its
 * shortest. The ceiling is still one walk — a state is not single-use, and the retry cannot
 * mint another — so a longer life costs nothing but a longer-lived nonce.
 */
export const LINE_STATE_TTL_SECONDS = 900;

/** What a verified state tells the callback: which door, and which attempt this is. */
export interface LineState {
  /** Which door minted it — the front door signs in, the account page binds. */
  intent: LineIntent;
  /** Whether this arrival is already the second walk (see `planLineRetry`). */
  retried: boolean;
}

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

/**
 * Signs a state that means one thing: sign this customer in, or bind this session.
 *
 * `retried` is minted only by the callback, on the one walk that follows a failed
 * arrival — the authorize route never sets it, so a press from the shop's own screen is
 * always a first attempt and always keeps its one retry in hand.
 */
export async function createLineState(
  intent: LineIntent,
  options: { retried?: boolean } = {},
): Promise<string> {
  return new SignJWT({ purpose: purposeForIntent(intent), retried: options.retried === true })
    .setProtectedHeader({ alg: 'HS256' })
    /*
     * A fresh id per state, not decoration: a JWS is deterministic over its claims, so two
     * presses in the same second used to mint byte-identical tokens. That was harmless while
     * the state was minted at a press — one browser, one token — but it is minted per page
     * render now, and two strangers loading the sign-in page inside one second would be
     * handed the same nonce; a proxy holding that page would hand it to everybody. With `jti`
     * "one render, one state" is true, which is what lets the acceptance run assert it.
     */
    .setJti(crypto.randomUUID())
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
 *
 * A state with no `retried` claim reads as a first attempt. That is not a hole: the claim
 * only ever *removes* a retry, so a state that omits it — one minted by a build from
 * before the claim existed, or by anybody else who holds the shared key — gets the same
 * single retry a fresh press gets, and no more than one walk can follow it.
 */
export async function verifyLineState(token: string): Promise<LineState> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), {
      issuer: STATE_ISSUER,
      audience: STATE_AUDIENCE,
    });

    const intent = intentForPurpose(payload.purpose);
    if (intent === null) {
      throw new InvalidLineStateError();
    }
    return { intent, retried: payload.retried === true };
  } catch (error) {
    if (error instanceof InvalidLineStateError) {
      throw error;
    }
    throw new InvalidLineStateError();
  }
}
