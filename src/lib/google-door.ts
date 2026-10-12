/**
 * Which of Google's two sign-in shapes a device gets, where the redirect one comes
 * back to, and what an arrival from it earns (ADR 0020 §1, amended).
 *
 * Google ships one button with two UX modes — `popup` and `redirect` — and `popup` is
 * the default. Until this module existed this deployment asked for the default on every
 * device, and the default is the wrong ask on the device this shop is built for.
 * Google's supported-browser page carries the footnote **"Due to ITP redirect mode is
 * required for iOS"**
 * (https://developers.google.com/identity/gsi/web/guides/supported-browsers), and the
 * reason lands in the same place ADR 0031 records from the other end: on iOS *every*
 * browser is WebKit, Safari's Intelligent Tracking Prevention is in the way of the
 * cross-origin `postMessage` the popup flow hands the credential back with, and there is
 * no browser for the customer to switch to. A shop whose customers hold iPhones cannot
 * keep asking for the mode Google documents as not for iOS.
 *
 * Two consequences, both deliberate:
 *
 *   * **The redirect mode needs an endpoint, not a page.** The credential arrives as a
 *     form POST to `login_uri` (`credential=<id token>`, beside a `g_csrf_token`), and
 *     Google's integration guide is explicit that "it's impossible to use a JavaScript
 *     callback function to handle the response, since users have already been redirected
 *     away from your web page"
 *     (https://developers.google.com/identity/gsi/web/guides/integrate). A page route
 *     cannot receive a POST in this framework, so the address is a route, it is built
 *     here, and the button carries it — one assembly, the same rule `lineRedirectUri`
 *     states for the LINE door.
 *   * **Which mode a device gets is a decision, not a branch inline in the screen.** It
 *     is read from the device, so it is a pure function with tests rather than a
 *     condition somebody has to keep in step with the browser they happen to hold.
 *
 * **The alternative rejected, and why.** *Redirect mode for every device.* It is one path
 * instead of two, and Google does recommend it for new integrations — but Google states
 * the requirement *for iOS*, the popup is the shape it calls "often preferred" on a
 * desktop, and a shop whose OAuth client has not registered the login URI yet would then
 * lose Google on **every** device at once instead of on the phones only. Switching the
 * deployment to redirect everywhere is one line here (`googleUxModeFor` returning the
 * constant) when that trade looks better than this one.
 */
import { homePathForRole } from './roles';

/** Google's two UX modes, spelled as its API spells them. */
export const GOOGLE_UX_MODE_POPUP = 'popup';
export const GOOGLE_UX_MODE_REDIRECT = 'redirect';

export type GoogleUxMode = 'popup' | 'redirect';

/**
 * The path Google POSTs a credential to in redirect mode — one literal, because the
 * button, the route that answers it and the operator's console registration all name it.
 */
export const GOOGLE_REDIRECT_LOGIN_PATH = '/api/v1/auth/google/redirect';

/**
 * The `login_uri` the whole flow has to agree on, on the deployment's own public address.
 *
 * Built from a passed-in base rather than from `request.url`, for the reason
 * `public-url.ts` records: behind the shop's reverse proxy the request's origin is
 * `localhost:3000`, and Google compares `login_uri` against the registered redirect URI
 * as a string — a different host is a `redirect_uri_mismatch` on Google's own error page.
 */
export function googleRedirectLoginUri(base: string): string {
  return `${base.replace(/\/+$/, '')}${GOOGLE_REDIRECT_LOGIN_PATH}`;
}

/**
 * Which mode this browser should be asked for.
 *
 * iOS is the whole point, and iOS is not one user agent. Safari on an iPad reports itself
 * as a Mac (`platform` `MacIntel`, no `iPad` anywhere in the string) and is only
 * distinguishable by having a touch screen — so the second signal is
 * `maxTouchPoints > 1`, and a Mac with a trackpad still reports 0 or 1. Missing signals
 * read as *not* iOS, which keeps the popup the default for anything this function cannot
 * recognise: a wrong answer in that direction is the behaviour the deployment already
 * had, where a wrong answer the other way would send a desktop through a mode it does not
 * need.
 *
 * Chrome and Firefox on iOS are `CriOS`/`FxiOS` and still match on the device token, which
 * is right: on iOS they are WebKit, so ITP is in front of them exactly as it is in front of
 * Safari.
 */
export function googleUxModeFor(input: {
  userAgent: string;
  maxTouchPoints?: number;
  platform?: string;
}): GoogleUxMode {
  const isIosDevice = /iPad|iPhone|iPod/.test(input.userAgent);
  const isIpadInDesktopMode = input.platform === 'MacIntel' && (input.maxTouchPoints ?? 0) > 1;

  return isIosDevice || isIpadInDesktopMode ? GOOGLE_UX_MODE_REDIRECT : GOOGLE_UX_MODE_POPUP;
}

/**
 * What to hand `google.accounts.id.initialize`.
 *
 * A function rather than an object literal inside the screen, because the *shape* of this
 * call is the defect this change exists to fix: a test can assert that a phone asks for
 * `redirect` with a `login_uri`, and that a desktop asks for neither and stays on Google's
 * default. `ux_mode` belongs here rather than on `renderButton`, which is where Google's
 * API reference puts it (https://developers.google.com/identity/gsi/web/reference/js-reference).
 *
 * `loginUri === null` means this deployment could not name its own public address (see
 * `publicBaseUrlForHeaders`), and redirect mode without a registered endpoint is not a
 * flow — so the mode falls back to popup rather than sending a phone to a POST nobody
 * answers. That is a degraded door, not a broken one.
 */
export function googleInitializeConfig(input: {
  clientId: string;
  mode: GoogleUxMode;
  loginUri: string | null;
}): { client_id: string; ux_mode?: GoogleUxMode; login_uri?: string } {
  if (input.mode === GOOGLE_UX_MODE_REDIRECT && input.loginUri !== null) {
    return { client_id: input.clientId, ux_mode: GOOGLE_UX_MODE_REDIRECT, login_uri: input.loginUri };
  }
  return { client_id: input.clientId };
}

/**
 * What an arrival at the redirect landing earns.
 *
 * The mirror of `planLineArrival`, and deliberately a closed set: the landing's job is to
 * do one of three things and nothing else. Google has no equivalent of LINE's two doors
 * here — this one only ever *signs a customer in* (ADR 0020 §1: a `member` may use it, a
 * `employee` or `admin` keeps phone and password) — so the only refusals worth naming are
 * the account that is closed and the account that is not a customer.
 */
export type GoogleDoorOutcome =
  | { kind: 'sign-in'; redirectTo: string }
  | { kind: 'needs-phone' }
  | { kind: 'refused'; reason: 'inactive' };

/**
 * A Google account nobody holds gets **no row written here**: it is handed to the phone
 * step, which is the only place a first sign-in may take a number (ADR 0020 §3). Writing
 * anything at this point would be a customer with no phone, which the rest of the system
 * cannot name.
 */
export function planGoogleArrival(input: {
  customer: { isActive: boolean } | null;
}): GoogleDoorOutcome {
  if (input.customer === null) {
    return { kind: 'needs-phone' };
  }
  if (!input.customer.isActive) {
    return { kind: 'refused', reason: 'inactive' };
  }
  return { kind: 'sign-in', redirectTo: homePathForRole('member') };
}

/**
 * The words the front door reads out of its query string after a redirect landing.
 *
 * `new` is the one that is a *step* rather than a message: it means a verified Google
 * account is waiting in the browser's own handoff cookie for a phone number, which the
 * page has to render (`google-pending.ts` is the other half of that promise).
 */
export type GoogleLandingResult = 'new' | 'inactive' | 'error';

/** Where a landing sends the browser, on the deployment's own public address. */
export function googleLandingUrl(base: string, result: GoogleLandingResult): string {
  return `${base.replace(/\/+$/, '')}/login?google=${result}`;
}
