/**
 * The customer's LINE card — ADR 0030.
 *
 * As with `login-staff-door.test.ts`, what is under test is largely an
 * *arrangement*: which tab the account page renders the LINE panel in, which
 * routes the card talks to, and what the server-side page reads before it
 * renders. Those are stated in the source rather than in runtime behaviour this
 * suite could execute (the page is a server component; the panel is client-side
 * against a fetch), so this suite reads the files the way the staff-door suite
 * does — the file that ships is the file under test. `isPublicPath` is pure and
 * imported for real, pinning that the new doors stay *outside* the public list.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isPublicPath } from '@/lib/roles';

const accountPage = (): string => readFileSync('src/app/(shop)/shop/account/page.tsx', 'utf8');
const accountPortal = (): string => readFileSync('src/components/shop/AccountPortal.tsx', 'utf8');
const accountRoute = (): string => readFileSync('src/app/api/v1/account/line/route.ts', 'utf8');
const loginPage = (): string => readFileSync('src/app/login/page.tsx', 'utf8');
const signIn = (): string => readFileSync('src/components/shop/CustomerSignIn.tsx', 'utf8');

describe('the LINE card on the account page', () => {
  it('is one tab of the portal, rendered from the page', () => {
    expect(accountPortal()).toContain("{ key: 'line', label: 'LINE' }");
    expect(accountPortal()).toContain('<LinePanel');
    expect(accountPage()).toContain('<AccountPortal');
    expect(accountPage()).toContain('line={');
  });

  it('reads the binding through the server, not the session token', () => {
    // Same argument as the phone: the card must show what is true now.
    expect(accountPage()).toContain('lineBindingForUser');
  });

  it('binds through the OAuth redirect, unbinds and re-consents through the API', () => {
    const panel = accountPortal();
    expect(panel).toContain('/api/v1/auth/line/authorize');
    expect(panel).toContain("apiPost('/api/v1/account/line', { unlink: true })");
    expect(panel).toContain("apiPost('/api/v1/account/line', { consentOnly: true })");
  });

  it('tells the customer about the friend condition, in the card', () => {
    // Consent is half the pair (ADR 0030 §2); the Official Account is the other
    // half, and a card that hid it would read as "the shop is ignoring me".
    expect(accountPortal()).toContain('เพิ่มเพื่อนร้านใน LINE');
  });

  it('offers withdrawal as one act that clears both facts', () => {
    expect(accountPortal()).toContain('ยกเลิกการผูกและหยุดรับการแจ้งเตือน');
  });
});

describe("the LINE door on the front door (/login)", () => {
  it('renders beside Google and the counter door, from a passed-in value', () => {
    // Found on the live deployment: the API doors existed and answered, but the
    // sign-in screen never gained the button — a customer meeting the shop on
    // LINE had no third door to walk through. The page passes the address down as
    // a value, the same argument as the Google door's, and for a second reason
    // now: a state signed on the server cannot be minted in the browser.
    expect(loginPage()).toContain('lineHref={lineHref}');
    expect(loginPage()).toContain("lineStartHref({ intent: 'sign-in'");
    expect(signIn()).toContain('<LineDoor');
    expect(signIn()).toContain('lineHref');
  });

  it('makes the press LINE’s own address, so the tap itself is the navigation', () => {
    /*
     * ADR 0030 §1, amended. LINE's guide to the phone failure names a JavaScript
     * redirect to the authorization URL as a case the app handoff does not
     * survive, and recommends letting the customer tap a button that goes to it;
     * a redirect of ours is the same shape one hop later. So the door holds no
     * route of ours and no handler — and it still spells no LINE literal, because
     * the page is what mints the address.
     */
    const source = signIn();
    const door = source.slice(source.indexOf('function LineDoor'), source.indexOf('function LineClaimStep'));

    expect(door).toContain('href={href}');
    expect(door).not.toContain('/api/v1/auth/line/authorize');
    expect(door).not.toContain('window.location');
    expect(door).not.toContain('https://access.line.me');
    expect(signIn()).not.toContain('https://access.line.me');
  });

  it('cannot be cached, because the address it carries is minted for that render', () => {
    // A build-time render, or a proxy holding the page, would hand every customer
    // one state — and after its life is up, one that is already dead. The page
    // reads cookies and search params already; this says the consequence out loud.
    expect(loginPage()).toContain("export const dynamic = 'force-dynamic'");
  });

  it('says plainly when the deployment has no channel, rather than hiding the door', () => {
    expect(signIn()).toContain('ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย LINE');
  });
});

describe('the sign-in half of the LINE flow', () => {
  it('names the door it is, so the account page’s press cannot sign somebody in', () => {
    // One press, one promise (ADR 0030 §1). The front door's state says `sign-in`, minted
    // by the page; the account card's press says `bind`. Neither passes a proof of its own
    // choosing — the intent is the only thing either address carries.
    expect(loginPage()).toContain("lineStartHref({ intent: 'sign-in'");
    expect(accountPortal()).toContain('/api/v1/auth/line/authorize?intent=bind');
  });

  it('finishes a first sign-in on the front door: a phone, a code, and the notice', () => {
    // Found in the field: this step did not exist, so an unbound LINE account could not
    // become a customer at all — the callback refused and the customer landed back on
    // the page they started from.
    expect(signIn()).toContain("'/api/v1/auth/line/link'");
    expect(signIn()).toContain("'/api/v1/auth/otp'");
    expect(signIn()).toContain('CURRENT_CUSTOMER_NOTICE_VERSION');
    expect(signIn()).toContain('<NoticeAcknowledge');
  });

  it('carries no LINE token in the body — the proof is the httpOnly handoff', () => {
    // The redirect flow's id token never reaches the browser, so the request this screen
    // sends must not pretend to hold one; the cookie the callback set is the credential.
    const source = signIn();
    const claimStep = source.slice(
      source.indexOf('function LineClaimStep'),
      source.indexOf('google door */'),
    );
    expect(claimStep).toContain('line/link');
    expect(claimStep).not.toContain('idToken');
  });

  it('reads the callback’s word on the server and hands it down as a value', () => {
    // Read on the page rather than in an effect, so the first paint is already the right
    // screen rather than the door followed by a step sliding in underneath it.
    expect(loginPage()).toContain('searchParams');
    expect(loginPage()).toContain('lineResult={line ?? null}');
  });

  it('accepts either LINE proof at /link, and exactly the one presented', () => {
    // Two ways in: an id token from the browser half, or the handoff cookie the redirect
    // half left behind. Both re-verified at this door rather than trusted from earlier.
    const linkRoute = readFileSync('src/app/api/v1/auth/line/link/route.ts', 'utf8');

    expect(linkRoute).toContain('LINE_PENDING_COOKIE');
    expect(linkRoute).toContain('verifyLinePendingToken');
    expect(linkRoute).toContain('verifyLineIdToken');
    // Spent, so it cannot be replayed with a different number from the same browser.
    expect(linkRoute).toContain('.cookies.delete(LINE_PENDING_COOKIE)');
  });

  it('shows the account card’s own LINE outcome instead of swallowing the query', () => {
    // The card used to read `?line=` and throw it away, so a failed binding looked like a
    // card that simply still said "not linked".
    expect(accountPortal()).toContain('lineAccountNotice');
    expect(accountPortal()).toContain("case 'taken':");
    expect(accountPortal()).toContain("case 'session':");
  });
});

describe('the LINE doors and the public-path list', () => {
  it('never puts a LINE door on the public list', () => {
    // Every one of these is either session-authenticated (`account/line`) or
    // credential/signature-authenticated (`webhook`, the callback). A door that
    // leaked onto `isPublicPath` would be open to the *pages* proxy with no
    // check at all, so this pins the negative.
    for (const path of [
      '/api/v1/auth/line',
      '/api/v1/auth/line/link',
      '/api/v1/auth/line/authorize',
      '/api/v1/auth/line/callback',
      '/api/v1/line/webhook',
      '/api/v1/account/line',
    ]) {
      expect(isPublicPath(path), path).toBe(false);
    }
  });

  it('answers every account act through one member-only route', () => {
    const route = accountRoute();
    // Bind, unbind and re-consent are three bodies on one door, and the door is
    // `requireRole(['member'])` — the role always comes from the session.
    expect(route).toContain("requireRole(['member'])");
    expect(route).toContain('unlink: true');
    expect(route).toContain('consentOnly: true');
    expect(route).toContain('verifyLineIdToken');
  });
});
