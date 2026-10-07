// Seam under test: the handoff token a finished LINE consent leaves for the phone
// step (ADR 0030 §1, amended).
//
// The redirect flow gets its id token on the *server* — LINE answers our callback
// with a code, and this process exchanges it. The browser, unlike the LIFF door,
// never holds one. So when the LINE account is nobody's yet, the proof that the
// subject is genuinely LINE's has to reach the screen that collects the phone, and
// this token is how: short-lived, httpOnly, and naming a LINE subject rather than a
// session, so holding it signs nobody in.
//
// The tests are mostly about what must *not* be accepted, for the reason the
// security audit gave this repo: every family under the one `AUTH_SECRET` must pin
// its own audience, and a verifier that only checks the signature cannot tell a
// pending LINE identity from a session or a pickup code.
import { describe, expect, it } from 'vitest';

import { DomainError } from '@/lib/errors';
import {
  LINE_PENDING_COOKIE,
  LINE_PENDING_TTL_SECONDS,
  LinePendingError,
  createLinePendingToken,
  linePendingCookieOptions,
  verifyLinePendingToken,
} from '@/lib/line-pending';
import { createPickupToken } from '@/lib/pickup-token';
import { createSessionToken } from '@/lib/session-token';

describe('the handoff a finished LINE consent leaves', () => {
  it('carries the LINE profile the id-token path would have carried, and no session', async () => {
    // The name and the address are the same two facts the browser half of the flow holds,
    // so a first sign-in through either door creates the same customer row.
    const token = await createLinePendingToken({
      subject: 'U1234',
      displayName: 'สมชาย',
      email: 'somchai@example.com',
    });

    expect(await verifyLinePendingToken(token)).toEqual({
      subject: 'U1234',
      displayName: 'สมชาย',
      email: 'somchai@example.com',
    });
  });

  it('carries nulls rather than inventing a name or an address', async () => {
    const token = await createLinePendingToken({
      subject: 'U1234',
      displayName: null,
      email: null,
    });
    expect(await verifyLinePendingToken(token)).toEqual({
      subject: 'U1234',
      displayName: null,
      email: null,
    });
  });

  it('expires on its own, so a handoff left in a browser does not keep working', async () => {
    // Ten minutes is one phone number typed and one code received. The token names a
    // LINE account that the unique index will refuse to move onto a second row, so a
    // long-lived one would be a standing invitation to try.
    const token = await createLinePendingToken({
      subject: 'U1234',
      displayName: 'สมชาย',
      email: null,
      ttlSeconds: -1,
    });

    await expect(verifyLinePendingToken(token)).rejects.toBeInstanceOf(LinePendingError);
  });

  it('refuses a session token, a pickup code and a LINE state, all signed with one key', async () => {
    const session = await createSessionToken({
      id: 'a-user',
      role: 'member',
      fullName: 'ลูกค้า',
      phone: '0900000001',
    });
    const pickup = await createPickupToken({
      orderId: '11111111-2222-3333-4444-555555555555',
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(verifyLinePendingToken(session)).rejects.toBeInstanceOf(LinePendingError);
    await expect(verifyLinePendingToken(pickup)).rejects.toBeInstanceOf(LinePendingError);
  });

  it('refuses a token with one character changed', async () => {
    const token = await createLinePendingToken({ subject: 'U1234', displayName: null, email: null });
    const [header, payload, signature] = token.split('.');
    const flipped = signature!.startsWith('A') ? 'B' : 'A';
    const tampered = `${header}.${payload}.${flipped}${signature!.slice(1)}`;

    await expect(verifyLinePendingToken(tampered)).rejects.toBeInstanceOf(LinePendingError);
  });

  it('refuses junk without pretending to know what it was', async () => {
    for (const junk of ['', 'x', 'not.a.token', 'a.b.c']) {
      await expect(verifyLinePendingToken(junk), junk).rejects.toBeInstanceOf(LinePendingError);
    }
  });

  it('fails as a domain error with words for the customer', async () => {
    // `withApi` maps `DomainError` onto HTTP and flattens the rest to a 500. An
    // expired handoff is the customer's own half-hour-ago, not our bug.
    const failure = await verifyLinePendingToken('not.a.token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).httpStatus).toBe(422);
    expect((failure as DomainError).code).toBe('LINE_PENDING_EXPIRED');
    expect((failure as Error).message).toContain('LINE');
  });
});

describe('the cookie the handoff rides in', () => {
  it('is unreadable by script and rides only our own top-level GETs back from LINE', () => {
    // `lax` and not `strict`: LINE sends the browser back with a top-level GET from
    // another origin, and a strict cookie is not sent with it — the handoff would
    // vanish at exactly the moment it is needed.
    const options = linePendingCookieOptions(false);

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(LINE_PENDING_TTL_SECONDS);
  });

  it('is Secure in production, like the session cookie it sits beside', () => {
    expect(linePendingCookieOptions(true).secure).toBe(true);
    expect(linePendingCookieOptions(false).secure).toBe(false);
  });

  it('does not share a name with the session', () => {
    expect(LINE_PENDING_COOKIE).not.toBe('pos_session');
  });
});
