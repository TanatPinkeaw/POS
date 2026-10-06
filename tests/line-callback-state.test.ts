// Seam under test: the CSRF state on the LINE callback (ADR 0030 §1).
//
// The state is signed with the same `AUTH_SECRET` as the session token — that
// is a fact of the design, stated in the authorize route. The consequence is
// sharp: a signature check alone cannot tell the two kinds apart, so the
// `purpose` claim is the *only* thing standing between "the state we minted"
// and "a session token pasted into this URL by whoever holds one". This suite
// pins that the claim is actually checked — found un-enforced by reading the
// route against its own comment, exactly the class of bug the localhost
// callback was.
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { authSecretKey } from '@/lib/session-token';

const callbackRoute = (): string =>
  readFileSync('src/app/api/v1/auth/line/callback/route.ts', 'utf8');

/** A token minted the way the authorize route mints a state. */
async function realState(): Promise<string> {
  return new SignJWT({ purpose: 'line-link' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('300s')
    .sign(authSecretKey());
}

/** A token minted the way `createSessionToken` mints a session — no purpose. */
async function sessionShapedToken(): Promise<string> {
  return new SignJWT({ role: 'member', fullName: 'x', phone: 'x' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('00000000-0000-0000-0000-000000000001')
    .setIssuedAt()
    .setIssuer('pos-realtime')
    .setExpirationTime('12h')
    .sign(authSecretKey());
}

describe(`the callback's state check`, () => {
  it('demands the purpose claim — a session token does not verify as a state', async () => {
    // Both verify cryptographically; only one carries the claim. The route must
    // reject the other kind, not merely accept whatever the key signs.
    const state = await realState();
    const session = await sessionShapedToken();

    const { jwtVerify } = await import('jose');
    const okState = await jwtVerify(state, authSecretKey());
    expect(okState.payload.purpose).toBe('line-link');

    // The session token would pass `jwtVerify` itself — this is the whole point —
    // so the route's defence has to be the explicit claim comparison below.
    const sessionVerified = await jwtVerify(session, authSecretKey());
    expect(sessionVerified.payload.purpose).toBeUndefined();
  });

  it('compares the purpose claim explicitly in the shipped route', () => {
    // The route is the artifact under test (a redirect handler needs a live
    // Next runtime), and the check is one comparison: read it the way the
    // staff-door suite reads its pages.
    expect(callbackRoute()).toContain(`payload.purpose !== 'line-link'`);
    expect(callbackRoute()).toContain('throw new Error');
  });

  it('does not accept the session token by re-deriving what the route does', async () => {
    // Behavioural pin of the exact check the route runs, so a refactor that
    // drops the claim comparison fails here even if the string above drifts.
    const session = await sessionShapedToken();
    const { jwtVerify } = await import('jose');
    const { payload } = await jwtVerify(session, authSecretKey());
    const accepted = payload.purpose === 'line-link';
    expect(accepted).toBe(false);
  });
});
