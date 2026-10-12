// Seam under test: the handoff a finished Google redirect sign-in leaves for the phone
// step (ADR 0020 §1, amended).
//
// The popup flow hands the browser an id token, so the screen that collects a number can
// post it back. The redirect flow — the one a phone gets, because Google requires it on
// iOS — cannot: Google POSTs the credential to this server, and the browser's copy never
// exists. So when the Google account is nobody's yet, the proof has to reach the screen
// that collects the phone, and this token is how: short-lived, httpOnly, and naming a
// Google subject rather than a session, so holding it signs nobody in.
//
// The tests are mostly about what must *not* be accepted, for the reason the security
// audit gave this repo: every family under the one `AUTH_SECRET` must pin its own audience,
// and a verifier that only checks the signature cannot tell a pending Google identity from
// a session, a pickup code, or the *LINE* handoff that looks almost exactly like it.
import { describe, expect, it } from 'vitest';

import { DomainError } from '@/lib/errors';
import {
  GOOGLE_PENDING_COOKIE,
  GOOGLE_PENDING_TTL_SECONDS,
  GooglePendingError,
  createGooglePendingToken,
  googlePendingCookieOptions,
  verifyGooglePendingToken,
} from '@/lib/google-pending';
import { createLinePendingToken, LINE_PENDING_COOKIE } from '@/lib/line-pending';
import { createPickupToken } from '@/lib/pickup-token';
import { createSessionToken } from '@/lib/session-token';

describe('the handoff a finished Google redirect sign-in leaves', () => {
  it('carries the profile the id-token path would have carried, and no session', async () => {
    // The name, the address and whether Google asserted it are the same facts the popup half
    // holds, so a first sign-in through either shape creates the same customer row.
    const token = await createGooglePendingToken({
      subject: '1081234567890',
      displayName: 'สมชาย',
      email: 'somchai@example.com',
      emailVerified: true,
    });

    expect(await verifyGooglePendingToken(token)).toEqual({
      subject: '1081234567890',
      displayName: 'สมชาย',
      email: 'somchai@example.com',
      emailVerified: true,
    });
  });

  it('carries nulls rather than inventing a name or an address', async () => {
    const token = await createGooglePendingToken({
      subject: '1081234567890',
      displayName: null,
      email: null,
      emailVerified: false,
    });
    expect(await verifyGooglePendingToken(token)).toEqual({
      subject: '1081234567890',
      displayName: null,
      email: null,
      emailVerified: false,
    });
  });

  it('expires on its own, so a handoff left in a browser does not keep working', async () => {
    // Ten minutes is one phone number typed and one notice read. The subject it names is
    // unique in `users.google_subject`, so a long-lived one would be a standing invitation
    // to try to attach it to a row.
    const token = await createGooglePendingToken({
      subject: '1081234567890',
      displayName: null,
      email: null,
      emailVerified: false,
      ttlSeconds: -1,
    });

    await expect(verifyGooglePendingToken(token)).rejects.toBeInstanceOf(GooglePendingError);
  });

  it('refuses a session token, a pickup code and a LINE handoff, all signed with one key', async () => {
    // The third one is the interesting one: `line-pending.ts` is the same shape of token
    // minted for the same kind of moment, and only the audience tells the two apart. A
    // verifier that skipped it would accept a LINE subject as a Google one.
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
    const line = await createLinePendingToken({
      subject: 'U1234',
      displayName: null,
      email: null,
    });

    await expect(verifyGooglePendingToken(session)).rejects.toBeInstanceOf(GooglePendingError);
    await expect(verifyGooglePendingToken(pickup)).rejects.toBeInstanceOf(GooglePendingError);
    await expect(verifyGooglePendingToken(line)).rejects.toBeInstanceOf(GooglePendingError);
  });

  it('refuses a token with one character changed', async () => {
    const token = await createGooglePendingToken({
      subject: '1081234567890',
      displayName: null,
      email: null,
      emailVerified: false,
    });
    const [header, payload, signature] = token.split('.');
    const flipped = signature!.startsWith('A') ? 'B' : 'A';
    const tampered = `${header}.${payload}.${flipped}${signature!.slice(1)}`;

    await expect(verifyGooglePendingToken(tampered)).rejects.toBeInstanceOf(GooglePendingError);
  });

  it('refuses junk without pretending to know what it was', async () => {
    for (const junk of ['', 'x', 'not.a.token', 'a.b.c']) {
      await expect(verifyGooglePendingToken(junk), junk).rejects.toBeInstanceOf(GooglePendingError);
    }
  });

  it('fails as a domain error with words for the customer', async () => {
    // `withApi` maps `DomainError` onto HTTP and flattens the rest to a 500. An expired
    // handoff is the customer's own ten-minutes-ago, not our bug — and the sentence names the
    // button they have to press, which is the only thing they can do about it.
    const failure = await verifyGooglePendingToken('not.a.token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).httpStatus).toBe(422);
    expect((failure as DomainError).code).toBe('GOOGLE_PENDING_EXPIRED');
    expect((failure as Error).message).toContain('Google');
  });
});

describe('the cookie the handoff rides in', () => {
  it('is unreadable by script and survives a cross-site post landing on this origin', () => {
    // `lax` and not `strict`: the cookie is written on the response to Google's form POST,
    // which is a cross-site top-level request. A strict cookie would not be stored at all,
    // and the phone step would find nothing waiting.
    const options = googlePendingCookieOptions(false);

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(GOOGLE_PENDING_TTL_SECONDS);
  });

  it('is Secure in production, like the session cookie it sits beside', () => {
    expect(googlePendingCookieOptions(true).secure).toBe(true);
    expect(googlePendingCookieOptions(false).secure).toBe(false);
  });

  it('shares its name with neither the session nor the LINE handoff', () => {
    expect(GOOGLE_PENDING_COOKIE).not.toBe('pos_session');
    expect(GOOGLE_PENDING_COOKIE).not.toBe(LINE_PENDING_COOKIE);
  });
});
