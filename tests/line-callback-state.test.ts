// Seam under test: the CSRF state on the LINE callback (ADR 0030 §1).
//
// The state is signed with the same `AUTH_SECRET` as the session token — that is a fact of
// the design, stated in the authorize route. The consequence is sharp: a signature check
// alone cannot tell the two kinds apart, so the claims are the *only* thing standing
// between "the state we minted for this browser" and "a session token pasted into this
// URL by whoever holds one". This suite used to be able to pin only the string comparison
// the route ran, because the check lived inline in a route handler that needs a Next
// runtime to execute.
//
// It now runs the real verifier (`line-state.ts`), which is the same arrangement the rest
// of the suite prefers: the behaviour is exercised rather than quoted. What it must keep
// proving is unchanged — that a token of another family is refused, and that a state
// minted for one door cannot be replayed at the other, which is a second confusion the
// front door's sign-in intent introduced.
import { SignJWT, jwtVerify } from 'jose';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DomainError } from '@/lib/errors';
import { createSessionToken, authSecretKey } from '@/lib/session-token';
import { createLineState, InvalidLineStateError, verifyLineState } from '@/lib/line-state';

const callbackRoute = (): string =>
  readFileSync('src/app/api/v1/auth/line/callback/route.ts', 'utf8');
const authorizeRoute = (): string =>
  readFileSync('src/app/api/v1/auth/line/authorize/route.ts', 'utf8');

/** A token minted the way `createSessionToken` mints a session — the old, claimless shape. */
async function sessionShapedToken(): Promise<string> {
  return new SignJWT({ role: 'member', fullName: 'x', phone: 'x' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('00000000-0000-0000-0000-000000000001')
    .setIssuedAt()
    .setIssuer('pos-realtime')
    .setExpirationTime('12h')
    .sign(authSecretKey());
}

describe('the state a LINE door mints', () => {
  it('round-trips the intent it was minted for', async () => {
    expect(await verifyLineState(await createLineState('bind'))).toBe('bind');
    expect(await verifyLineState(await createLineState('sign-in'))).toBe('sign-in');
  });

  it('keeps the two doors apart, so neither state can be replayed at the other', async () => {
    // The front door signs in; the account page binds. A state that did not say which
    // would let a callback started from one screen do the other screen's write.
    const forAccount = await createLineState('bind');
    const forFrontDoor = await createLineState('sign-in');

    const { payload: bindPayload } = await jwtVerify(forAccount, authSecretKey());
    const { payload: signInPayload } = await jwtVerify(forFrontDoor, authSecretKey());

    expect(bindPayload.purpose).not.toBe(signInPayload.purpose);
  });

  it('refuses a session token, which the one shared key signs just as well', async () => {
    // The confusion the audit demonstrated between a pickup code and a session, one family
    // over: without the audience claim this token verifies and its `role` field would be
    // read as if a LINE consent had happened.
    await expect(verifyLineState(await sessionShapedToken())).rejects.toBeInstanceOf(
      InvalidLineStateError,
    );
    await expect(
      verifyLineState(
        await createSessionToken({ id: 'a', role: 'member', fullName: 'x', phone: '0900000001' }),
      ),
    ).rejects.toBeInstanceOf(InvalidLineStateError);
  });

  it('refuses a state-shaped token that carries no purpose we mint', async () => {
    // Right audience, right issuer, wrong question: signed by us, but not for either door.
    const claimless = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('pos-realtime')
      .setAudience('line-state')
      .setExpirationTime('300s')
      .sign(authSecretKey());

    await expect(verifyLineState(claimless)).rejects.toBeInstanceOf(InvalidLineStateError);
  });

  it('stops working after five minutes', async () => {
    // Both timestamps absolute: `setExpirationTime('300s')` is relative to *now*, so a
    // token with an hour-old `iat` and a relative expiry is still perfectly valid — the
    // test would pass on a verifier that checked nothing.
    const issuedAt = Math.floor(Date.now() / 1000) - 3600;
    const stale = await new SignJWT({ purpose: 'line-link' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(issuedAt)
      .setIssuer('pos-realtime')
      .setAudience('line-state')
      .setExpirationTime(issuedAt + 300)
      .sign(authSecretKey());

    await expect(verifyLineState(stale)).rejects.toBeInstanceOf(InvalidLineStateError);
  });

  it('refuses junk without pretending to know what it was', async () => {
    for (const junk of ['', 'x', 'not.a.token', 'a.b.c']) {
      await expect(verifyLineState(junk), junk).rejects.toBeInstanceOf(InvalidLineStateError);
    }
  });

  it('fails as a domain error, so the browser gets a sentence rather than a 500', async () => {
    const failure = await verifyLineState('not.a.token').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).httpStatus).toBe(422);
    expect((failure as DomainError).code).toBe('INVALID_LINE_STATE');
  });
});

describe('the routes that mint and check it', () => {
  it('signs the state through this module in the authorize route', () => {
    // The route is the artifact under test for the mint half — a redirect handler needs a
    // live Next runtime — so the check is that it does not hand-roll a token of its own.
    expect(authorizeRoute()).toContain('createLineState');
    expect(authorizeRoute()).not.toContain('new SignJWT');
  });

  it('verifies the state through this module in the callback route', () => {
    expect(callbackRoute()).toContain('verifyLineState');
    expect(callbackRoute()).not.toContain('jwtVerify');
  });
});
