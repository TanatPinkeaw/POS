/**
 * The front door belongs to the customer — ADR 0029.
 *
 * What is under test here is an *arrangement*, not a computation: which component
 * each sign-in route renders, and where the staff form hides behind. That is stated
 * in the source of the pages rather than in runtime behaviour this suite could
 * execute — the pages are server components that redirect and query the database —
 * so this suite reads the files the way `offline-shell.test.ts` reads the shipped
 * worker: the file that ships is the file under test. The two tables it relies on
 * (`ROUTE_WALK`, `isPublicPath`) are pure and imported for real.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ROUTE_WALK } from '@/lib/route-audit';
import { isPublicPath } from '@/lib/roles';

const loginPage = (): string => readFileSync('src/app/login/page.tsx', 'utf8');
const staffToggle = (): string => readFileSync('src/components/auth/StaffDoorToggle.tsx', 'utf8');
const shopPage = (): string => readFileSync('src/app/shop/page.tsx', 'utf8');

describe('the front door (/login) is the customer door', () => {
  it("renders the customer's two doors, not a staff form", () => {
    expect(loginPage()).toContain('<CustomerSignIn');
  });

  it('reaches the staff form only through the folded control', () => {
    const page = loginPage();
    expect(page).toContain('<StaffDoorToggle');
    // The old page imported the staff form directly; the only import left is the
    // one the toggle owns.
    expect(page).not.toContain("from '@/components/auth/LoginForm'");
    // Found by opening the real page in a browser: an import without a render
    // type-checks, passes everything, and hands staff a panel with no form in it.
    expect(staffToggle()).toContain('<LoginForm />');
  });

  it('keeps the privacy notice at the door (ADR 0020)', () => {
    expect(loginPage()).toContain('<PrivacyScrim');
  });

  it('shows the demo accounts only inside the staff panel, never to customers', () => {
    const page = loginPage();
    expect(page).toContain('DEMO_ACCOUNTS');
    // The demo block is slotted into the toggle as children, so it renders inside
    // the fold or not at all — the page has no place of its own to print it.
    const toggleBody = page.slice(
      page.indexOf('<StaffDoorToggle'),
      page.indexOf('</StaffDoorToggle>'),
    );
    expect(toggleBody).toContain('styles.demo');
  });

  it('opens the staff panel with a toggle a screen reader can follow', () => {
    const source = staffToggle();
    expect(source).toContain('aria-expanded');
    expect(source).toContain('aria-controls');
  });
});

describe('/shop sends the customer to the one door', () => {
  it('is a redirect, not a second sign-in page', () => {
    const page = shopPage();
    expect(page).toContain("redirect('/login')");
    expect(page).not.toContain('CustomerSignIn');
  });

  it('stays public, so the redirect itself is what answers an old link', () => {
    // If /shop stopped being public, the proxy would answer a printed QR with a
    // bounce of its own; the door must be the one answering.
    expect(isPublicPath('/shop')).toBe(true);
  });

  it('is walked to /login, so the route audit asserts the redirect on a real server', () => {
    const entry = ROUTE_WALK.find((spec) => spec.path === '/shop');
    expect(entry?.landsOn).toBe('/login');
    expect(entry?.session).toBe('none');
  });
});
