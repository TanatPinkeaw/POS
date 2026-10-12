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
  | { page: 'login'; result: 'claim' | 'session' | 'inactive' | 'staff' | 'error' | 'expired' };

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

/** The front door, on the deployment's own public address. */
function loginPageUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}/login`;
}

/**
 * The front door with **nothing said**.
 *
 * This is the landing for a request that was not an arrival: `GET` at the callback address
 * with no `code`, no `state` and no error of LINE's. Nobody started a sign-in, so there is
 * no outcome to report — and an outcome invented here is a sentence about a walk nobody
 * took. It used to answer `?line=error`, which the front door reads as "เข้าสู่ระบบด้วย LINE
 * ไม่สำเร็จ": the operator opening the callback address to see that it is alive was told
 * their own sign-in had failed, and so was anybody who clicked a landing URL back out of
 * their history. Found on the shop's own deployment, from the operator doing exactly that.
 *
 * Built from a passed-in base rather than from `request.url`, for the reason `public-url.ts`
 * records: behind the shop's reverse proxy the request's origin is `localhost:3000`, and a
 * customer redirected there is a customer who cannot reach the page.
 */
export function loginLandingUrl(base: string): string {
  return loginPageUrl(base);
}

/**
 * A landing URL on the deployment's own public address, carrying the word.
 *
 * One function for both pages, because the words and the addresses are decided together:
 * `lineLandingFor` says which page an outcome is answered on, and this says what the
 * address looks like. `null` is not a value here — see `loginLandingUrl` for the landing
 * that says nothing at all.
 */
export function lineLandingUrl(base: string, landing: LineLanding): string {
  const page = landing.page === 'account' ? '/shop/account' : '/login';
  return `${base.replace(/\/+$/, '')}${page}?line=${landing.result}`;
}

/** Where LINE shows the customer their consent screen. */
export const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize';

/** The path LINE returns the customer to. One literal, because three screens spell it. */
export const LINE_CALLBACK_PATH = '/api/v1/auth/line/callback';

/**
 * The `redirect_uri` the whole flow has to agree on.
 *
 * LINE compares this character for character at the token exchange, and three places name
 * it: the sign-in page that mints the press (through `lineStartHref`), the authorize route,
 * and the callback — which also uses it for the retry, so the second walk asks for the same
 * address the first one did. Built here rather than spelled out at each of the three, for
 * the reason the address below is: a difference of one slash is an exchange that refuses for
 * a reason nobody has seen before.
 */
export function lineRedirectUri(base: string): string {
  return `${base.replace(/\/+$/, '')}${LINE_CALLBACK_PATH}`;
}

/**
 * The URL a press of a door is sent to — built in one place, because three callers build it.
 *
 * The callback sends a second attempt here; the authorize route sends a first one for a
 * caller that reached it directly; and the sign-in page puts a first one in the button's
 * own `href`, which is now how the customer usually arrives. The second address differs
 * from the first by exactly one parameter. Two assemblies of the same query is how they
 * drift, and drift here is not cosmetic: `scope` is what makes LINE return an id token at
 * all, and `redirect_uri` has to match the authorize request character for character at the
 * token exchange, so a retry that forgot one of them would be a remedy that fails for a new
 * reason.
 *
 * `disableAutoLogin` is LINE's own remedy for the failure this module also plans for: on a
 * phone whose auto login did not complete, LINE's documentation says to send the customer
 * back here with auto login switched off, so LINE shows the email-and-password screen in
 * the browser instead of trying to launch its app again. Off for a first attempt, because
 * the app handoff is the smoother path when it works; on for the single retry.
 */
export function buildLineAuthorizeUrl(input: {
  channelId: string;
  redirectUri: string;
  state: string;
  disableAutoLogin: boolean;
}): string {
  const url = new URL(LINE_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.channelId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  // The id token is what this system verifies; the profile names the customer.
  url.searchParams.set('scope', 'openid profile email');
  // `code` keeps the customer in the browser flow rather than LINE's app.
  url.searchParams.set('prompt', 'consent');
  if (input.disableAutoLogin) {
    url.searchParams.set('disable_auto_login', 'true');
  }
  return url.toString();
}

/**
 * How an arrival from LINE failed, in the four ways this deployment can tell apart.
 *
 * The vocabulary is the *stage* the flow died at, because that is what decides whether
 * another walk through LINE's screens could plausibly end differently.
 */
export type LineArrivalFailure =
  /** LINE answered the callback with an error of its own (`?error=…`). */
  | 'line-error'
  /** A code arrived and did not become an id token (LINE answered `invalid_grant`). */
  | 'code-exchange'
  /** An id token arrived and did not verify — the same channel, a token we refuse. */
  | 'credential'
  /** No code, or a deployment with no channel id and secret to ask LINE with. */
  | 'incomplete';

/**
 * Whether a failed arrival earns one more walk through LINE's screens, auto login off.
 *
 * This is the shape of a phone-only failure, and it is documented rather than guessed at.
 * LINE's "How to handle auto login failure" says that when the LINE app's auto login fails
 * — private browsing, or an OS whose Universal Links did not fire — the browser is still
 * sent to the callback, **with `code` and `state`**, and that the code is "an invalid value,
 * so you can't issue an access token". Read from this side that is one symptom: the
 * exchange fails and the customer, who did nothing wrong, would otherwise be handed
 * "please try again" for a failure that will happen every time. LINE's own recommended
 * reply is the second walk this returns, and it is the *only* reason a retry exists —
 * nothing else here is fixed by walking LINE's consent screens again.
 *
 * Four cases, each one a decision:
 *
 *   * **`incomplete`** never retries. LINE has not answered yet, so there is nothing to
 *     answer differently, and a deployment missing its channel id would otherwise walk the
 *     customer through a second dead end.
 *   * **`credential`** never retries. A token signed by our own channel that this server
 *     refuses is a configuration problem (a rotated channel secret, a clock); walking the
 *     same screens again mints the same refusal.
 *   * **`line-error`** retries once, *except* when the error is `access_denied` — that is
 *     the customer pressing cancel on LINE's own screen, and asking again without being
 *     asked is not a remedy, it is a loop.
 *   * **`code-exchange`** retries once: the documented signature of the failure above.
 *
 * `retried` is the ceiling. It comes from the signed state, so a retry can never mint
 * another retry, and the worst a hostile callback can do is spend its own one.
 */
export function planLineRetry(input: {
  failure: LineArrivalFailure;
  /** LINE's `?error=` value, when it sent one. */
  lineError?: string | null;
  retried: boolean;
}): 'retry' | 'fail' {
  if (input.retried || input.failure === 'incomplete' || input.failure === 'credential') {
    return 'fail';
  }
  if (input.failure === 'line-error' && input.lineError === 'access_denied') {
    return 'fail';
  }
  return 'retry';
}
