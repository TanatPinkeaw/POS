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
