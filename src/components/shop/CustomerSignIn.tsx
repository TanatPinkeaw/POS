'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, InlineNotice, TextField } from '@/components/ds';
import { apiPost } from '@/lib/client-api';
import { type GoogleUxMode, googleInitializeConfig, googleUxModeFor } from '@/lib/google-door';
import { CURRENT_CUSTOMER_NOTICE_VERSION } from '@/lib/privacy-notice';

// The stylesheet lives beside the front door it styles: `/login` is the only screen
// that renders this component since the doors swapped (ADR 0029) — `/shop` is a redirect.
import styles from '@/app/login/customer-signin.module.css';

import { NoticeAcknowledge } from './NoticeAcknowledge';

interface LoginResponse {
  role: 'member' | 'employee' | 'admin';
  redirectTo: string;
}

interface GoogleDoorResponse {
  needsPhone?: boolean;
  id?: string;
  redirectTo?: string;
}

interface SignupResponse {
  redirectTo: string;
}

/* --- the thin slice of Google Identity Services this screen uses --------- */

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    /**
     * Google's two UX modes, only one of which this deployment may use on a phone — see
     * `google-door.ts`. Both belong on `initialize`, not on `renderButton`, which is where
     * Google's JavaScript API reference puts them.
     */
    ux_mode?: GoogleUxMode;
    login_uri?: string;
  }): void;
  renderButton(element: HTMLElement, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
  }
}

const GOOGLE_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/**
 * How long a painted Google button is given before the door concludes it never arrived.
 *
 * Five seconds, measured from the script's `onload`: `renderButton` paints into an iframe
 * that has to load from Google's own origin after the API calls back, so the gap is a
 * network round trip and not a tick. The failure this exists to catch — an origin Google
 * has not been told about, or a browser that blocks the frame — leaves the slot empty
 * forever, and an empty slot is the white box the shop reported: no button, no message,
 * nothing to press and nothing to read.
 */
const GOOGLE_BUTTON_GRACE_MS = 5_000;

/**
 * What the front door says about a LINE arrival that did not sign anyone in.
 *
 * Pure and exported so it can be tested as behaviour rather than read as markup: every
 * one of these sentences is the difference between a customer knowing what to do next and
 * a customer pressing the same button again. The `?line=` codes are the callback's
 * (`line-door.ts`), and the ones that are not ours — `bound`, `taken`, or anything a
 * stranger types into the URL — get no notice at all, because inventing a message for an
 * unknown code is how a message ends up lying about what happened.
 *
 * `claim` is absent on purpose: it is not a notice, it is the step below.
 */
export function lineDoorNotice(
  result: string | null | undefined,
): { tone: 'danger' | 'warning'; body: string } | null {
  switch (result) {
    case 'session':
      // The account page's own press, arriving without the session it needs — usually a
      // customer whose session expired while they were on LINE's screens.
      return {
        tone: 'warning',
        body: 'การผูกบัญชี LINE ต้องเข้าสู่ระบบก่อน — เข้าสู่ระบบด้วยเบอร์โทรหรือ Google ให้เรียบร้อย แล้วกลับมาที่หน้าบัญชีของฉัน → แท็บ LINE อีกครั้ง',
      };
    case 'inactive':
      return { tone: 'danger', body: 'บัญชีนี้ถูกปิดการใช้งานแล้ว — กรุณาติดต่อร้านที่เคาน์เตอร์' };
    case 'staff':
      // Not "พนักงาน" alone: every non-member row lands here, and this repo's own vocabulary
      // has two words for those (ROLE_LABEL) — an owner reading "พนักงาน" about their own
      // account would be reading something false.
      return {
        tone: 'danger',
        body: 'บัญชีนี้เป็นบัญชีของพนักงานหรือผู้ดูแล ไม่ใช่บัญชีลูกค้า — ใช้เบอร์โทรศัพท์และรหัสผ่านเข้าสู่ระบบแทน LINE',
      };
    case 'expired':
      /*
       * The state we minted is missing, or past its fifteen minutes: a tab left open while the
       * customer phoned somebody, a URL that lost its query, a landing re-opened from history.
       * Nothing is wrong with LINE and nothing is wrong with the customer, so this is the one
       * sentence that is true — start again — and it is a warning rather than a danger.
       */
      return {
        tone: 'warning',
        body: 'การยืนยันกับ LINE ไม่สมบูรณ์หรือหมดอายุแล้ว — กดปุ่มเข้าสู่ระบบด้วย LINE อีกครั้งเพื่อเริ่มใหม่',
      };
    case 'error':
      return {
        tone: 'danger',
        body: 'เข้าสู่ระบบด้วย LINE ไม่สำเร็จ — กดปุ่ม LINE อีกครั้งได้เลย',
      };
    default:
      return null;
  }
}

/**
 * What the front door says about a Google arrival that did not sign anyone in.
 *
 * The `?google=` codes are the redirect landing's (`google-door.ts`), and only two of them
 * are sentences: `new` is the *step* this screen renders (below), and a code nobody minted
 * gets no notice at all — inventing a sentence for an unknown code is how a screen ends up
 * lying about what happened. `lineDoorNotice` states the same rule for LINE, and the two
 * are kept apart on purpose, so one door's words can never be printed over the other's
 * failure.
 */
export function googleDoorNotice(
  result: string | null | undefined,
): { tone: 'danger'; body: string } | null {
  switch (result) {
    case 'inactive':
      return { tone: 'danger', body: 'บัญชีนี้ถูกปิดการใช้งานแล้ว — กรุณาติดต่อร้านที่เคาน์เตอร์' };
    case 'error':
      return {
        tone: 'danger',
        body: 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ หรือการยืนยันหมดอายุ — กดปุ่ม Google อีกครั้งได้เลย',
      };
    default:
      return null;
  }
}

/**
 * Which of the front door's arrival codes the address may keep.
 *
 * A code that renders a **step** is addressable and has to survive a reload: `claim` puts the
 * phone-and-OTP form on screen from the first paint and `new` does the same for Google, and the
 * proof each leans on (an httpOnly handoff) is in the browser either way — a customer who
 * reloads mid-flow must not be sent back to the button.
 *
 * A code that renders a **sentence** is momentary: it reports a walk that has already ended.
 * Left in the address it is re-read by every re-open — the back button, a bookmark, a link
 * pasted into a chat, the shop's operator checking that the page answers — and each of those
 * reads a failure that is over. So the address is rewritten once the sentence has been painted.
 *
 * One rule for both doors, and it is derived rather than listed: the two notice functions say
 * which codes carry a sentence, which is also why `claim` and `new` fall out of this empty by
 * themselves. The shop's own report is why this exists — the landing the callback had just
 * redirected to was re-opened and printed "เข้าสู่ระบบด้วย LINE ไม่สำเร็จ" about a sign-in that
 * was not attempted.
 */
export function momentaryCodes(input: {
  line?: string | null;
  google?: string | null;
}): string[] {
  const stale: string[] = [];
  if (lineDoorNotice(input.line) !== null) {
    stale.push('line');
  }
  if (googleDoorNotice(input.google) !== null) {
    stale.push('google');
  }
  return stale;
}

/**
 * What the Google door says when its button never appears.
 *
 * Three ways to arrive here and one sentence to leave by, because the customer's next
 * move is identical in all three: the script did not load, the API was not on it, or
 * `renderButton` painted nothing. All three used to render an empty white slot; naming
 * them for the console is what makes a field report diagnosable, and the sentence the
 * customer reads names the door that does work.
 */
export function googleDoorFailure(problem: 'script' | 'api' | 'blank'): string {
  const reason =
    problem === 'script'
      ? 'โหลดสคริปต์ของ Google ไม่ได้'
      : problem === 'api'
        ? 'เบราว์เซอร์นี้ไม่เปิดให้ใช้ปุ่มของ Google'
        : 'ปุ่มของ Google ไม่แสดงในเบราว์เซอร์นี้';

  return `${reason} — ใช้เบอร์โทรศัพท์และรหัสผ่านด้านล่างแทนได้เลย`;
}

/**
 * The width handed to `renderButton`, measured from the slot it will sit in.
 *
 * `renderButton` accepts 200–400 for a large standard button — below the floor it
 * refuses to render, above the ceiling it overflows its own frame — so a slot
 * narrower than the floor still requests the floor and leans on the slot's own
 * `justify-content: center`, rather than sending Google a width that cannot work.
 */
export function buttonWidthFor(available: number): number {
  return Math.max(200, Math.min(Math.floor(available), 400));
}

/**
 * The customer's three doors (ADR 0020 §3, §7; ADR 0030).
 *
 * The counter door is phone and password — the same thing the shop enrolled the
 * customer with — Google is the self-serve one, and LINE is the door a customer who met
 * the shop in LINE reaches for. None hides the others: this is the screen the ticket
 * asks for where a walk-in and a customer who found the shop online both have a way in.
 *
 * Both third-party doors are **data**, not hard dependencies. When the deployment has a
 * `GOOGLE_CLIENT_ID` or a `LINE_LOGIN_CHANNEL_ID`, the door is live; without one it is
 * present but says plainly that the shop has not configured it, rather than showing a
 * control that cannot work — and a shop that configures neither fetches nothing from
 * either provider on its sign-in page.
 */
export function CustomerSignIn({
  googleClientId,
  googleLoginUri = null,
  googleResult = null,
  lineHref = null,
  lineResult = null,
}: {
  googleClientId: string | null;
  /**
   * The address Google POSTs the credential to in redirect mode, built by the page from the
   * deployment's own public address (`google-door.ts`).
   *
   * `null` when the shop has no client id, or when the request could not name its own
   * address — and the Google door then stays on Google's popup default rather than pointing
   * a phone at a POST nobody answers. A degraded door, not a broken one.
   */
  googleLoginUri?: string | null;
  /**
   * The `?google=` code the redirect landing came back with, if any.
   *
   * Read on the server and handed down as a value, for the reason `lineResult` is: `new`
   * means the phone step must render in the first paint. Left to a client effect, the
   * customer would see the door, and then watch a different screen slide in beneath them.
   */
  googleResult?: string | null;
  /**
   * LINE's own authorization URL, minted by the page for this render (ADR 0030 §1,
   * amended) — the door's whole address, state included.
   *
   * Passed in as a *value* rather than assembled here, like the Google client id beside
   * it: this component is the client half, and a URL built in the browser cannot carry a
   * state the server signed, nor know the address the shop is reachable at behind its
   * proxy. `null` — no channel configured, or a page that could not name its own address —
   * renders the sentence that says so rather than a link to nowhere.
   */
  lineHref?: string | null;
  /**
   * The `?line=` code the callback redirected with, if any.
   *
   * Read on the server and handed down as a value, like `lineHref`: the screen
   * then renders the outcome in the same paint as the door, instead of a client effect
   * rewriting the page a moment later.
   */
  lineResult?: string | null;
}) {
  /**
   * Where every door sends a customer who has just been signed in.
   *
   * A **document** load, not `router.replace` plus `router.refresh`. Two reasons, and
   * the second is the one that was measured: the session cookie was written by the POST
   * that just answered, and only a fresh document is guaranteed to be rendered by a
   * server that sees it — while the pair of router calls fired in one tick was a race
   * with the navigation it was trying to hurry along. A sign-in is a boundary; a full
   * load there is the honest implementation of one.
   */
  const go = useCallback((path: string) => {
    window.location.assign(path);
  }, []);

  /*
   * A sentence that has been read is spent, so it comes out of the address — see
   * `momentaryCodes` for the rule and for why a step stays. `replaceState` rather than a
   * navigation: the page that is on screen is the page that was asked for, and the router
   * (Next 16 keeps the App Router in step with the history API) is told, not reloaded.
   */
  useEffect(() => {
    const spent = momentaryCodes({ line: lineResult, google: googleResult });
    if (spent.length === 0) {
      return;
    }
    const url = new URL(window.location.href);
    for (const name of spent) {
      url.searchParams.delete(name);
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [lineResult, googleResult]);

  return (
    <div className={styles.form}>
      <GoogleDoor
        googleClientId={googleClientId}
        googleLoginUri={googleLoginUri}
        googleResult={googleResult}
        onSignedIn={go}
      />
      <LineDoor href={lineHref} result={lineResult} onSignedIn={go} />
      <p className={styles.divider}>หรือ</p>
      <CounterDoor onSignedIn={go} />
    </div>
  );
}

/* ---------------------------------------------------------------- line door */

/**
 * The LINE door (ADR 0030 §1) — a third way in, beside Google and the counter's
 * phone-and-password.
 *
 * A plain link rather than LINE's own widget: LINE Login is a redirect flow, not an
 * embedded script, so this door needs no third-party JS at all — the browser walks to
 * LINE's consent screen and comes back.
 *
 * **The link *is* LINE's authorization address**, handed down by the page, rather than a
 * route of ours that answers with a redirect to it. That is not a style choice: LINE's
 * guide to the phone failure this door already recovers from lists a JavaScript redirect
 * to the authorization URL among the cases where the app handoff does not happen, and
 * recommends letting the customer tap a button that goes to the authorization URL. A tap
 * on LINE's own address is that; a tap on a route of ours followed by a `307` is not.
 *
 *   * **A LINE account that is already bound signs straight in.** The state the page
 *     minted says `sign-in`, so the callback knows which door this is and starts a
 *     session; before that, the link pointed at the *binding* flow, which needs the
 *     session the visitor has not got — consent, then straight back to this page. That is
 *     the loop this screen was reported for.
 *   * **A LINE account that is nobody's yet asks for a phone number**, which is the one
 *     thing LINE cannot tell us and the shop cannot skip: a LINE account arriving from a
 *     browser proves the LINE account and nothing about the number a customer's points
 *     and orders hang from (ADR 0030 §1). The verified LINE identity has already been
 *     handed back to this browser by the callback, so the step below completes without a
 *     second walk through LINE.
 *
 * When the deployment has no channel, the door says so plainly rather than
 * disappearing — the same honesty the Google door renders — because "where did
 * the button go" is a worse question than "why is this grey".
 *
 * An `<a>`, not a button with a handler: a plain navigation is what a tap on a Universal
 * Link looks like to iOS, and a `window.location` assignment is the shape LINE's guide
 * names as the one the handoff does not survive.
 */
function LineDoor({
  href,
  result,
  onSignedIn,
}: {
  href: string | null;
  result: string | null;
  onSignedIn: (path: string) => void;
}) {
  /**
   * Whether the phone step is showing.
   *
   * Seeded from the callback's own redirect rather than from an effect, so a customer
   * arriving back from LINE sees the step in the first paint. Local state afterwards,
   * because "ใช้ LINE บัญชีอื่น" has to be able to leave it without a reload.
   */
  const [claiming, setClaiming] = useState(result === 'claim');
  const notice = lineDoorNotice(result);

  return (
    <section className={styles.door} aria-label="เข้าสู่ระบบด้วย LINE">
      <p className={styles.doorTitle}>มีบัญชี LINE</p>

      {notice ? <InlineNotice tone={notice.tone}>{notice.body}</InlineNotice> : null}

      {href === null ? (
        <InlineNotice tone="info">
          ร้านนี้ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย LINE — ใช้เบอร์โทรศัพท์และรหัสผ่านด้านล่างได้เลย
        </InlineNotice>
      ) : claiming ? (
        <LineClaimStep
          onSignedIn={onSignedIn}
          onRestart={() => {
            setClaiming(false);
          }}
        />
      ) : (
        <>
          <a className={styles.lineButton} href={href}>
            เข้าสู่ระบบด้วย LINE
          </a>
          <p className={styles.stepHint}>
            ถ้าบัญชี LINE นี้ยังไม่เคยผูกกับร้าน ระบบจะขอเบอร์มือถือเพื่อยืนยันตัวตนหนึ่งครั้ง
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The phone step: the number, a code, and the notice.
 *
 * The number is **proved** rather than typed, which is the whole difference between this
 * and the Google door's second step (ADR 0030 §1): a LINE account nobody holds may be
 * anchored to a row that already holds points and history, so a typed number here would
 * be the takeover ADR 0020 §4 refuses. The code goes to the number being anchored to and
 * is consumed by `bindLineToCustomer` before anything is written.
 *
 * The LINE side of the proof is not in this form at all — it is in the httpOnly handoff
 * cookie the callback left behind, which is why there is no token in this payload and why
 * a browser that lost the cookie is told to start again rather than being let through.
 */
function LineClaimStep({
  onSignedIn,
  onRestart,
}: {
  onSignedIn: (path: string) => void;
  onRestart: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);

  const normalised = phone.replace(/[\s()\-.]/g, '');

  async function sendCode(): Promise<void> {
    setError(null);
    setSending(true);
    try {
      await apiPost('/api/v1/auth/otp', { phone: phone.trim() });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ส่งรหัสไม่สำเร็จ');
    } finally {
      setSending(false);
    }
  }

  async function confirm(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      const result = await apiPost<SignupResponse>('/api/v1/auth/line/link', {
        phone: phone.trim(),
        code: code.trim(),
        noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
      });
      onSignedIn(result.redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ผูกบัญชี LINE ไม่สำเร็จ');
      setSaving(false);
    }
  }

  return (
    <div className={styles.door}>
      {/*
        The step the customer did not expect, said as a requirement rather than left to be
        inferred: the LINE account is confirmed, the *number* is what the shop still needs.
        Same shape as the Google door's second step, for the same reason.
      */}
      <InlineNotice tone="warning" title="ขั้นตอนที่ 2 จาก 2">
        <strong>ยืนยันเบอร์มือถือ</strong> เพื่อผูกบัญชี LINE นี้กับบัญชีลูกค้าของร้าน —
        เบอร์เป็นตัวตนที่คะแนนและประวัติการซื้อผูกอยู่ เราจึงส่งรหัสยืนยันไปที่เบอร์นั้น
      </InlineNotice>

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <TextField
        id="linePhone"
        label="เบอร์มือถือของคุณ"
        inputMode="tel"
        autoComplete="tel"
        required
        placeholder="08xxxxxxxx"
        value={phone}
        onChange={(event) => {
          setPhone(event.target.value);
          // Editing the number invalidates the code that was sent to the old one — and
          // the server refuses a code whose challenge was sent elsewhere anyway.
          setSent(false);
        }}
        help="ใช้เป็นตัวระบุตัวตนของบัญชี และติดต่อกลับได้ในกรณีที่มีปัญหากับออเดอร์"
      />

      {!sent ? (
        <Button
          variant="secondary"
          size="lg"
          block
          loading={sending}
          disabled={normalised.length === 0}
          onClick={() => void sendCode()}
        >
          ส่งรหัสไปที่เบอร์นี้
        </Button>
      ) : (
        <TextField
          id="linePhoneCode"
          label="รหัสยืนยัน 6 หลัก"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
          help="รหัสใช้ได้ครั้งเดียวและหมดอายุใน 5 นาที"
        />
      )}

      <NoticeAcknowledge acknowledged={acknowledged} onChange={setAcknowledged} />

      <Button
        variant="primary"
        size="lg"
        block
        loading={saving}
        disabled={!sent || code.trim().length === 0 || !acknowledged}
        onClick={() => void confirm()}
      >
        ยืนยันและเข้าสู่ระบบ
      </Button>

      {/* The never-silent half of a disabled button, said the way the Google step says it. */}
      {!sent ? (
        <p className={styles.stepHint}>กด “ส่งรหัสไปที่เบอร์นี้” แล้วกรอกรหัสที่ได้รับก่อน</p>
      ) : code.trim().length === 0 || !acknowledged ? (
        <p className={styles.stepHint} role="alert">
          {code.trim().length === 0 && !acknowledged
            ? 'กรอกรหัสยืนยันและอ่านนโยบายด้านบนก่อน จึงจะกดยืนยันได้'
            : code.trim().length === 0
              ? 'ยังไม่ได้กรอกรหัสยืนยัน'
              : 'ยังไม่ได้อ่านและยืนยันนโยบายคุ้มครองข้อมูลส่วนบุคคล'}
        </p>
      ) : null}

      <Button variant="ghost" block onClick={onRestart}>
        ใช้ LINE บัญชีอื่น
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------- google door */

function GoogleDoor({
  googleClientId,
  googleLoginUri,
  googleResult,
  onSignedIn,
}: {
  googleClientId: string | null;
  googleLoginUri: string | null;
  googleResult: string | null;
  onSignedIn: (path: string) => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the button itself never arrived — kept apart from `error` on purpose.
   *
   * A refusal to sign this customer in (`error`) leaves a working button on screen to press
   * again; a door that never painted has nothing to press, so its slot is hidden and the
   * notice takes its place. One state for both would either hide a button that works or leave
   * the white box this exists to remove.
   */
  const [trouble, setTrouble] = useState<string | null>(null);
  /**
   * Whether the phone step is showing.
   *
   * Seeded from the redirect landing's own redirect (`?google=new`) as well as set by the
   * popup path below, for the reason `LineDoor` seeds `claiming` from `?line=`: a customer
   * coming back from Google's own page must see the step in the first paint. The two roads
   * differ only in *where the proof is* — an id token in the ref below for a popup, the
   * httpOnly handoff cookie for a redirect — and both end at the same POST.
   */
  const [needsPhone, setNeedsPhone] = useState(googleResult === 'new');
  /** What the landing said, if it said anything. `new` is the step above, not a sentence. */
  const googleNotice = googleDoorNotice(googleResult);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  /** Whether the customer has confirmed reading the privacy notice. */
  const [acknowledged, setAcknowledged] = useState(false);

  /*
   * The id token is held in a ref rather than state: it is a credential the
   * follow-up signup re-presents, and nothing renders from it, so putting it in
   * state would be a re-render carrying a secret for no reason.
   */
  const idToken = useRef<string | null>(null);

  /**
   * The sentence for a door that could not paint, and the line that makes it diagnosable.
   *
   * The customer reads the sentence; the operator gets this line, because a third-party script
   * that never arrives is invisible on a desktop and "Google is just white" carries no stage at
   * all. The same rule the LINE callback's refusals follow, and the same words: English in the
   * log, Thai on the screen.
   */
  const troubleFor = useCallback((problem: 'script' | 'api' | 'blank') => {
    console.warn(`[google] the door could not paint a button: ${problem}`);
    return googleDoorFailure(problem);
  }, []);

  const handleCredential = useCallback(
    async (token: string): Promise<void> => {
      idToken.current = token;
      setError(null);
      try {
        const result = await apiPost<GoogleDoorResponse>('/api/v1/auth/google', { idToken: token });
        if (result.needsPhone) {
          setNeedsPhone(true);
          return;
        }
        if (result.redirectTo) {
          onSignedIn(result.redirectTo);
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ');
      }
    },
    [onSignedIn],
  );

  useEffect(() => {
    if (googleClientId === null) {
      return;
    }
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const script = document.createElement('script');
    script.src = GOOGLE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;

    /*
     * A script that never loads used to leave the slot empty and silent, which is the
     * white box a customer reported on the shop's own phone. A blocked third-party
     * script is the common cause and it is not a bug we can fix — but saying so, and
     * naming the door that does work, is the difference between a customer who signs in
     * and a customer who leaves.
     */
    script.onerror = () => {
      if (!cancelled) {
        setTrouble(troubleFor('script'));
      }
    };

    script.onload = () => {
      const api = window.google?.accounts?.id;
      if (cancelled || !api || !slot.current) {
        if (!cancelled && !api) {
          setTrouble(troubleFor('api'));
        }
        return;
      }
      const slotElement = slot.current;
      /*
       * Which of Google's two UX modes this device is asked for — the call this screen used
       * to make with neither, and therefore with Google's `popup` default (ADR 0020 §1,
       * amended). A phone gets `redirect`, because Google's supported-browser page says
       * "Due to ITP redirect mode is required for iOS" and the phones this shop's customers
       * hold are iPhones (ADR 0031); in that mode the credential comes back as a form POST
       * to the landing route and this `callback` is never invoked at all. Every other
       * device keeps the popup, which is the default and the shape Google calls "often
       * preferred" on a desktop.
       */
      const mode = googleUxModeFor({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        platform: navigator.platform,
      });
      api.initialize({
        ...googleInitializeConfig({ clientId: googleClientId, mode, loginUri: googleLoginUri }),
        callback: (response) => {
          if (response.credential) {
            void handleCredential(response.credential);
          }
        },
      });

      /*
       * Google paints its button into an iframe sized once, from the width handed
       * to `renderButton`, and never measures the container again. A fixed 320 px
       * overflowed the card on the right on the phone this shop supports — a
       * 283 px slot on an iPhone 7 Plus — and sat hard left of centre on a wide
       * one, because the iframe is placed at the slot's left edge. So the width is
       * read from the slot itself and read again whenever the slot changes size:
       * rotation, a foldable, a zoom. (ResizeObserver is Safari 13.1, above the
       * 15.6 floor of ADR 0031.) `replaceChildren` first, because a second render
       * into a slot still holding the first frame stacks two iframes.
       */
      const renderAtWidth = (): void => {
        if (cancelled) {
          return;
        }
        slotElement.replaceChildren();
        api.renderButton(slotElement, {
          type: 'standard',
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          width: buttonWidthFor(slotElement.clientWidth),
        });
        // A frame arrived, so the failure this timer exists for did not: an origin Google
        // has not been told about paints nothing at all, and there is no error to catch.
        if (slotElement.children.length > 0) {
          setTrouble(null);
        }
      };

      renderAtWidth();

      graceTimer = setTimeout(() => {
        if (!cancelled && slotElement.children.length === 0) {
          setTrouble(troubleFor('blank'));
        }
      }, GOOGLE_BUTTON_GRACE_MS);

      /*
       * ResizeObserver fires once when observation starts, with the width the
       * render above already used — the comparison skips that one, so the button
       * is rendered exactly once at rest.
       */
      let lastWidth = buttonWidthFor(slotElement.clientWidth);
      observer = new ResizeObserver(() => {
        const width = buttonWidthFor(slotElement.clientWidth);
        if (width === lastWidth) {
          return;
        }
        lastWidth = width;
        renderAtWidth();
      });
      observer.observe(slotElement);
    };
    document.head.appendChild(script);

    return () => {
      cancelled = true;
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
      }
      observer?.disconnect();
      script.remove();
    };
  }, [googleClientId, googleLoginUri, handleCredential, troubleFor]);

  /**
   * The first sign-in: the phone, the notice, and nothing else.
   *
   * No code is asked for (ADR 0020 §5): Google proves the Google account, and the
   * number is only where the new customer's points and orders will hang. A number that
   * already has a customer is refused by the server rather than linked, which is the
   * one answer the screen has to relay in Thai.
   *
   * **The notice is part of this step, not a step of its own.** The customer arrived
   * here to buy something, and a separate screen between the phone and the button is a
   * screen they will dismiss. So it sits inline, above the button, and the button stays
   * disabled until it has been read — the shop's duty to inform, discharged in the flow
   * rather than parked one click away.
   */
  async function completeSignup(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      /*
       * Which proof travels is not this screen's decision to make and not a parameter a
       * caller chooses: a popup holds an id token and sends it; a redirect holds nothing a
       * script can read, because Google POSTed the token to the landing, which left an
       * httpOnly handoff cookie instead. So the payload carries the phone always and the
       * token only when there is one, and the server is what requires *a* proof — the guard
       * that used to stand here (`if (idToken.current === null) return`) would have made a
       * phone's second step impossible, which is the bug this change removes.
       */
      const result = await apiPost<SignupResponse>('/api/v1/auth/signup', {
        ...(idToken.current === null ? {} : { idToken: idToken.current }),
        phone: phone.trim(),
        noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
      });
      onSignedIn(result.redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'สมัครสมาชิกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.door} aria-label="เข้าสู่ระบบด้วย Google">
      <p className={styles.doorTitle}>ลูกค้าใหม่ หรือมีบัญชี Google</p>

      {googleNotice ? (
        <InlineNotice tone={googleNotice.tone}>{googleNotice.body}</InlineNotice>
      ) : null}
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      {trouble ? <InlineNotice tone="danger">{trouble}</InlineNotice> : null}

      {googleClientId === null ? (
        <InlineNotice tone="info">
          ร้านนี้ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google — ใช้เบอร์โทรศัพท์และรหัสผ่านด้านล่างได้เลย
        </InlineNotice>
      ) : trouble !== null ? null : !needsPhone ? (
        <div className={styles.googleSlot} ref={slot} />
      ) : (
        <div className={styles.door}>
          {/*
            The one step in this flow a customer cannot skip, said as a requirement
            rather than left to be inferred.

            The screen used to show a grey sentence above an empty box, and the
            obvious reading was "optional field, move on" — people tapped through it,
            hit a disabled button with no stated reason, and left. Google proves who
            they are; the number is where their points and their orders hang, so
            without it the account cannot be created at all (ADR 0020 §5).

            So this is a warning-toned banner with the word จำเป็น in it, the field is
            focused, and the button explains itself instead of simply being grey.
            `InlineNotice` already carries its own live region — `assertive` for a
            warning tone — so this step is announced when it appears after the network
            round trip, without a second nested region competing with it.
          */}
          <InlineNotice tone="warning" title="ขั้นตอนที่ 2 จาก 2">
            <strong>จำเป็นต้องกรอกเบอร์มือถือ</strong> เพื่อเปิดบัญชีลูกค้า — เบอร์นี้ใช้ผูกคะแนนสะสม
            ประวัติการซื้อ และใช้ยืนยันตัวตนเวลาจองสินค้า ร้านจะใช้ส่งแจ้งเตือนเรื่องพรีออเดอร์ให้คุณเท่านั้น
          </InlineNotice>
          <TextField
            id="googlePhone"
            label="เบอร์มือถือของคุณ"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            required
            placeholder="08xxxxxxxx"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            help="ใช้เป็นตัวระบุตัวตนของบัญชี และติดต่อกลับได้ในกรณีที่มีปัญหากับออเดอร์"
          />
          <NoticeAcknowledge acknowledged={acknowledged} onChange={setAcknowledged} />
          <Button
            variant="primary"
            size="lg"
            block
            loading={busy}
            disabled={phone.trim().length === 0 || !acknowledged}
            onClick={() => void completeSignup()}
          >
            ยืนยันและเข้าสู่ระบบ
          </Button>
          {/*
            The never-silent half of a button that is disabled for two different
            reasons. Without it the customer sees a grey button and has to guess which
            of the two is still missing.
          */}
          {phone.trim().length === 0 || !acknowledged ? (
            <p className={styles.stepHint} role="alert">
              {phone.trim().length === 0 && !acknowledged
                ? 'กรอกเบอร์มือถือและอ่านนโยบายด้านบนก่อน จึงจะกดยืนยันได้'
                : phone.trim().length === 0
                  ? 'ยังไม่ได้กรอกเบอร์มือถือ'
                  : 'ยังไม่ได้อ่านและยืนยันนโยบายคุ้มครองข้อมูลส่วนบุคคล'}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- counter door */

function CounterDoor({ onSignedIn }: { onSignedIn: (path: string) => void }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<LoginResponse>('/api/v1/auth/login', {
        identifier: identifier.trim(),
        password,
      });
      onSignedIn(result.redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เข้าสู่ระบบไม่สำเร็จ');
      setBusy(false);
    }
  };

  return (
    <section className={styles.door} aria-label="เข้าสู่ระบบด้วยเบอร์โทรศัพท์">
      <p className={styles.doorTitle}>ลูกค้าที่ลงทะเบียนไว้แล้ว</p>
      <form className={styles.form} onSubmit={submit} noValidate>
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

        <TextField
          id="shopIdentifier"
          label="เบอร์โทรศัพท์"
          autoComplete="username"
          inputMode="tel"
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          required
        />
        <TextField
          id="shopPassword"
          label="รหัสผ่าน"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          เข้าสู่ระบบ
        </Button>
      </form>
    </section>
  );
}
