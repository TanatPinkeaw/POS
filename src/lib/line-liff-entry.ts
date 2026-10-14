/**
 * The in-LINE entry — what `/line` decides, purely (ADR 0032 §1).
 *
 * A LIFF app is a registration **inside the existing LINE Login channel** whose endpoint
 * URL is a route of this deployment, so a customer who taps a link in the shop's chat
 * arrives at `/line` inside LINE's own browser with their LINE account already open. The
 * entry's whole job is to turn that into the session every other customer screen already
 * uses, and to get out of the way: the catalogue, the orders and the e-receipt are the
 * pages that exist, rendered in LINE's browser exactly as they are anywhere else
 * (ADR 0030 §6 left that decision open and this ADR takes it that way).
 *
 * Pure and `liff`-free on purpose. The SDK cannot be imported by a unit test — it talks to
 * LINE's servers — so the decision is a function of facts the caller passes in, and the
 * component is the adapter: initialise, ask this module what that means, do it. Same split
 * as `line-door.ts`, and for the same reason: "a press of the front door signs in" is a
 * test case here instead of a promise in a comment.
 *
 * Three facts decide everything, and each has a sentence rather than a silent default:
 *
 *   * **Is this deployment configured at all?** Without `LINE_LIFF_ID` there is no entry
 *     to hand a customer — and there cannot have been a link to tap — so this wins over
 *     every other answer: a door that is not a door says so.
 *   * **Is this browser inside LINE?** LIFF initialises in an external browser too, but a
 *     customer who arrived there did not come from the shop's chat and would be asked to
 *     log into LINE itself. That is a step nobody asked for, so the entry names the app
 *     and points at the ordinary doors instead.
 *   * **Does the LINE account already resolve to a customer?** If not, the phone step
 *     renders **in this page** rather than bouncing out to `/login` (ADR 0032 §1): the
 *     id token exists in this browser only, and a customer thrown out of LINE to a web
 *     form is where a first sign-in dies.
 */
import { homePathForRole } from './roles';

/** The route a LIFF app's endpoint URL is set to. */
export const LIFF_ENTRY_PATH = '/line';

/** LINE's short link, which is what a message should carry rather than the endpoint. */
export const LIFF_SHORT_URL_PREFIX = 'https://liff.line.me';

/** The existing door the entry posts its id token to (ADR 0030 §1). */
export const LIFF_SIGN_IN_ENDPOINT = '/api/v1/auth/line';

/** Where a customer lands once the session exists. */
export function liffSignedInPath(): string {
  return homePathForRole('member');
}

/** The LIFF app's id, or null when this deployment has no in-LINE entry. */
export function readLiffId(env: Record<string, string | undefined> = process.env): string | null {
  const id = env.LINE_LIFF_ID?.trim();
  return id && id.length > 0 ? id : null;
}

/**
 * The address a message should carry: `https://liff.line.me/<liffId>`.
 *
 * One builder for every caller, exactly as `lineRedirectUri` is for the callback — a
 * second assembly is how one of them drifts, and a message that points at
 * `https://liff.line.me/` would open LINE with nothing in it.
 *
 * Null when no LIFF app is configured, so the planner can leave the sentence it sends
 * today completely alone rather than appending a link to nowhere.
 */
export function liffEntryUrl(env: Record<string, string | undefined> = process.env): string | null {
  const id = readLiffId(env);
  return id === null ? null : `${LIFF_SHORT_URL_PREFIX}/${id}`;
}

/** Why the entry could not sign anybody in, in the three shapes that actually happen. */
export type LiffEntryFailure =
  /** LINE's own script never loaded: no network, a blocked origin, an offline phone. */
  | 'sdk'
  /** The SDK answered but no id token came back (the customer refused the profile scope). */
  | 'token'
  /** LINE verified, and this deployment refused the account (inactive, or a staff row). */
  | 'refused';

/**
 * What `/line` should be showing.
 *
 * `claim` carries the LINE display name so the phone step can greet the customer with
 * something true about them, and `signed_in` carries the path the session earned — the
 * one value the module cannot derive, because it comes from the server's own answer.
 */
export type LiffEntryState =
  | { stage: 'unconfigured' }
  | { stage: 'open_in_line' }
  | { stage: 'sign_in' }
  | { stage: 'claim'; displayName: string | null }
  | { stage: 'signed_in'; redirectTo: string }
  | { stage: 'failed'; reason: LiffEntryFailure };

/**
 * The one rule, in the order the facts override each other.
 *
 * The order is the decision: configuration beats failure (a missing `LINE_LIFF_ID` did not
 * fail, it was never set up), failure beats the browser check (an honest error is worth
 * more than "open this in the app"), and a server answer beats everything it can (once a
 * session exists, the entry is done regardless of where the browser is).
 */
export function planLiffEntry(input: {
  /** Whether this deployment has a LIFF app id at all. */
  configured: boolean;
  /** `liff.isInClient()` — true only inside LINE's own browser. */
  inLineClient: boolean;
  /** Set once the sign-in call has been refused by LINE or by this deployment. */
  failure?: LiffEntryFailure | null;
  /**
   * Whether the server answered `needsPhone` for this LINE account.
   *
   * A flag rather than "is the display name set", because LINE answers an id token with no
   * name when the profile scope was not granted — and a null name is still a *claim*
   * (`inbound_payments.amount`'s lesson: one column must not mean two things).
   */
  needsPhone?: boolean;
  /** What LINE says this account is called, for the phone step to greet them with. */
  displayName?: string | null;
  /** Set when the server answered with a session, to the path it named. */
  redirectTo?: string | null;
}): LiffEntryState {
  if (!input.configured) {
    return { stage: 'unconfigured' };
  }
  if (input.failure) {
    return { stage: 'failed', reason: input.failure };
  }
  if (input.redirectTo) {
    return { stage: 'signed_in', redirectTo: input.redirectTo };
  }
  if (input.needsPhone) {
    return { stage: 'claim', displayName: input.displayName ?? null };
  }
  if (!input.inLineClient) {
    return { stage: 'open_in_line' };
  }
  return { stage: 'sign_in' };
}

/**
 * The sentence a customer reads, or null when the stage is a *doing* rather than a saying.
 *
 * The same shape as `lineDoorNotice`: one closed set of stage-to-copy, so a new reason
 * costs a sentence here rather than a re-derivation at the call site — and so a screen can
 * never print nothing about something that went wrong.
 */
export function liffEntryNotice(
  state: LiffEntryState,
): { tone: 'danger' | 'warning' | 'info'; body: string } | null {
  switch (state.stage) {
    case 'unconfigured':
      return {
        tone: 'info',
        body: 'ร้านนี้ยังไม่ได้ตั้งค่าทางเข้า LINE — ใช้เบอร์โทรศัพท์หรือ Google เข้าสู่ระบบได้ตามปกติ',
      };
    case 'open_in_line':
      return {
        tone: 'info',
        body: 'ลิงก์นี้ใช้ได้ในแอป LINE เท่านั้น — เปิดจากข้อความของร้านในแอป LINE อีกครั้ง หรือเข้าสู่ระบบที่หน้าแรก',
      };
    case 'failed':
      switch (state.reason) {
        case 'sdk':
          return {
            tone: 'warning',
            body: 'โหลดตัวช่วยของ LINE ไม่สำเร็จ — ตรวจการเชื่อมต่อแล้วเปิดลิงก์อีกครั้ง หรือเข้าสู่ระบบที่หน้าแรก',
          };
        case 'token':
          return {
            tone: 'warning',
            body: 'ยืนยันบัญชี LINE ไม่สำเร็จ — เปิดลิงก์จากข้อความของร้านอีกครั้ง และกดยินยอมให้เข้าถึงโปรไฟล์',
          };
        case 'refused':
          return {
            tone: 'danger',
            body: 'บัญชี LINE นี้เข้าสู่ระบบไม่ได้ — ใช้เบอร์โทรศัพท์และรหัสผ่านที่หน้าแรก หรือติดต่อร้านที่เคาน์เตอร์',
          };
      }
    case 'sign_in':
    case 'claim':
    case 'signed_in':
      // A doing, not a saying: the button, the phone step, and the redirect.
      return null;
  }
}
