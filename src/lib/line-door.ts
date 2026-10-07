/**
 * The intent a LINE door carries, and what an arrival from LINE earns
 * (ADR 0030 §1, amended).
 *
 * Two doors use one redirect flow, and which one a press is *means* something:
 * the front door signs a customer in, the account page binds a LINE account to the
 * row the browser is already signed in as. The old code had one flow and one
 * meaning — the binding one — so the front door's button walked a customer through
 * LINE's consent screen and handed them back to the login page they started on,
 * because `/shop/account` requires the member session the visitor had just failed
 * to obtain.
 *
 * Everything here is pure: no storage, no crypto, no clock. The callback is then
 * an adapter — verify the state, exchange the code, ask this module what the answer
 * is, do it — which is what makes "pressing the front door signs in" a test case
 * instead of a promise in a comment.
 */
import { homePathForRole } from './roles';

/**
 * The `purpose` claim a minted state carries, one per door.
 *
 * The state is a bearer value the browser hands back, so which door minted it has
 * to travel *inside* the signature rather than in a query string an attacker could
 * edit — otherwise a `bind` state could be replayed at the sign-in door, or the
 * reverse, which is the same class of confusion the state's own checks exist to
 * prevent.
 */
export const LINE_LINK_PURPOSE = 'line-link';
export const LINE_SIGNIN_PURPOSE = 'line-signin';

/** What a press of one of the two doors is asking for. */
export type LineIntent = 'sign-in' | 'bind';

/** The landing places a LINE arrival can be sent to. */
export type LineLanding =
  | { page: 'account'; result: 'bound' | 'taken' | 'error' }
  | { page: 'login'; result: 'claim' | 'session' | 'inactive' | 'staff' | 'error' };

/** Why an arrival was refused, in the vocabulary the landing URL speaks. */
export type LineRefusalReason = 'inactive' | 'staff' | 'binding-needs-session';

/**
 * What an arrival from LINE earns.
 *
 * A closed set, because the callback's job is to do one of these four things and
 * nothing else — the shape that keeps a route handler from growing a fifth branch
 * nobody tested.
 */
export type LineDoorOutcome =
  | { kind: 'sign-in'; redirectTo: string }
  | { kind: 'bind' }
  | { kind: 'needs-phone' }
  | { kind: 'refused'; reason: LineRefusalReason };

/**
 * Which door a press came from.
 *
 * An explicit request wins, and the fallback is derived from the session rather
 * than from anything the caller said. Two consequences, both deliberate:
 *
 *   * **A bare `/api/v1/auth/line/authorize` can never loop.** With no session it
 *     means *sign in* — the reading a customer pressing a button that says
 *     "เข้าสู่ระบบด้วย LINE" has every right to — so an old bookmark, a printed QR
 *     or a link somebody pasted into a chat all behave.
 *   * **An explicit `?intent=sign-in` is honoured even when a session exists**, so a
 *     shared tablet signed in as somebody else cannot have a sign-in press quietly
 *     become a write on the row that happened to hold the session.
 *
 * A value that is neither is ignored rather than refused: a mistyped URL is not a
 * person's mistake worth a dead end.
 */
export function lineIntentFor(input: {
  requested: string | null | undefined;
  hasSession: boolean;
}): LineIntent {
  if (input.requested === 'sign-in') {
    return 'sign-in';
  }
  if (input.requested === 'bind') {
    return 'bind';
  }
  return input.hasSession ? 'bind' : 'sign-in';
}

/** The state claim minted for an intent — the two must not be interchangeable. */
export function purposeForIntent(intent: LineIntent): string {
  return intent === 'bind' ? LINE_LINK_PURPOSE : LINE_SIGNIN_PURPOSE;
}

/**
 * The intent a verified state claims, or `null` for anything else.
 *
 * `null` rather than a default, and that is the security half of this module: the
 * state is signed with the same `AUTH_SECRET` as every other family, so a signature
 * check alone cannot tell a state from a session token, a pickup code or a receipt
 * link. The purpose claim is what tells them apart, and a value that is neither of
 * ours is refused rather than guessed at.
 */
export function intentForPurpose(purpose: unknown): LineIntent | null {
  if (purpose === LINE_LINK_PURPOSE) {
    return 'bind';
  }
  if (purpose === LINE_SIGNIN_PURPOSE) {
    return 'sign-in';
  }
  return null;
}

/**
 * What the callback should do, given what it now knows.
 *
 * `customer` is whatever `line_subject` resolved to — the arrival has already been
 * proved to be LINE's by the time this is asked, so the only questions left are
 * which door this is and who (if anyone) already holds that LINE account.
 *
 * The order inside the sign-in branch is the takeover rule of ADR 0030 §1 stated as
 * control flow: a subject nobody holds gets **no** row written here. It is handed
 * to the phone step, which is the only place an unproved subject may be attached.
 */
export function planLineArrival(input: {
  intent: LineIntent;
  session: { role: string } | null;
  customer: { role: string; isActive: boolean } | null;
}): LineDoorOutcome {
  if (input.intent === 'bind') {
    // The session is the whole takeover argument for a binding, so there is
    // nothing else to check and nothing to do without one.
    if (input.session === null || input.session.role !== 'member') {
      return { kind: 'refused', reason: 'binding-needs-session' };
    }
    return { kind: 'bind' };
  }

  if (input.customer === null) {
    return { kind: 'needs-phone' };
  }
  // A closed account is the more important fact, so it is answered before the role
  // question: "this account is closed" is true whatever the row is for.
  if (!input.customer.isActive) {
    return { kind: 'refused', reason: 'inactive' };
  }
  if (input.customer.role !== 'member') {
    return { kind: 'refused', reason: 'staff' };
  }
  return { kind: 'sign-in', redirectTo: homePathForRole('member') };
}

/**
 * Where an outcome is answered. A sign-in is not in this list, because it is the one
 * outcome that is a real navigation rather than a message.
 *
 * Every refusal lands on `/login`, deliberately, including the ones that happened
 * on the account page: `/shop/account` needs a member session to render at all, so
 * a refusal aimed there is a refusal nobody reads — which is exactly how the
 * reported loop stayed silent instead of saying "this LINE is not linked to a
 * customer yet".
 */
export function lineLandingFor(
  outcome: Exclude<LineDoorOutcome, { kind: 'sign-in' }>,
): LineLanding {
  switch (outcome.kind) {
    case 'bind':
      return { page: 'account', result: 'bound' };
    case 'needs-phone':
      return { page: 'login', result: 'claim' };
    case 'refused':
      return {
        page: 'login',
        result: outcome.reason === 'binding-needs-session' ? 'session' : outcome.reason,
      };
  }
}

/**
 * A landing URL on the deployment's own public address.
 *
 * Built from a passed-in base rather than from `request.url`, for the reason
 * `public-url.ts` records: behind the shop's reverse proxy the request's origin is
 * `localhost:3000`, and a customer redirected there is a customer who cannot reach
 * the page the refusal is written on.
 */
export function lineLandingUrl(base: string, landing: LineLanding): string {
  const path = landing.page === 'account' ? '/shop/account' : '/login';
  return `${base.replace(/\/+$/, '')}${path}?line=${landing.result}`;
}
