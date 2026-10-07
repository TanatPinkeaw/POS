// Seam under test: which tokens the session verifier accepts.
//
// Every token this app mints — session, supervisor approval, pickup code,
// receipt link, LINE state — is signed with the one `AUTH_SECRET`. A signature
// therefore proves only "minted here", never "is a session", and the audience
// claim is the check that tells the families apart. The session family shipped
// without one: its verifier accepted any same-key token carrying a string
// `role` field, which is to say its only defence against the pickup and
// receipt families was that their payloads happen not to have one. Found by
// the security audit (finding `auth.session-token.audience-absent`) with this
// exact shape demonstrated; the suite keeps it refused.
//
// The mirror test — a session offered as a pickup code — already lives in
// `tests/pickup-token.test.ts` and has passed from the start; the audience was
// pinned only on that side.
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  authSecretKey,
  createSessionToken,
  InvalidSessionError,
  verifySessionToken,
} from '@/lib/session-token';

/** Mints a token exactly the way `createPickupToken` does, plus a role field. */
async function pickupShapedToken(): Promise<string> {
  return new SignJWT({ scope: 'pickup', role: 'admin', fullName: 'แฝง', phone: '0800000009' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('11111111-2222-3333-4444-555555555555')
    .setIssuedAt()
    .setIssuer('pos-realtime')
    .setAudience('pickup-handover')
    .setExpirationTime('10m')
    .sign(authSecretKey());
}

/** Mints a well-signed session-family token that names the wrong audience. */
async function wrongAudienceToken(): Promise<string> {
  return new SignJWT({ role: 'admin', fullName: 'แฝง', phone: '0800000009' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('attacker')
    .setIssuedAt()
    .setIssuer('pos-realtime')
    .setAudience('some-other-consumer')
    .setExpirationTime('10m')
    .sign(authSecretKey());
}

describe('the session token audience', () => {
  it('verifies the token the app mints', async () => {
    const user = await verifySessionToken(
      await createSessionToken({
        id: '00000000-0000-0000-0000-000000000001',
        role: 'member',
        fullName: 'ลูกค้า',
        phone: '0800000001',
      }),
    );
    expect(user.role).toBe('member');
  });

  it('refuses a pickup-shaped token carrying a role field, though the key and issuer match', async () => {
    // The audit's demonstration, kept as a pin: without the audience check this
    // verifies as an admin session, because the payload shape is the shape the
    // verifier reads. Both families share the issuer 'pos-realtime'.
    await expect(verifySessionToken(await pickupShapedToken())).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
  });

  it('refuses a same-key token that names any other audience', async () => {
    await expect(verifySessionToken(await wrongAudienceToken())).rejects.toBeInstanceOf(
      InvalidSessionError,
    );
  });

  it('carries the audience on mint, so a future verifier cannot silently drop the claim', async () => {
    // Read the claim off the token rather than trusting the mint code: a refactor
    // that removes `.setAudience` fails here before any acceptance test can.
    const token = await createSessionToken({
      id: '00000000-0000-0000-0000-000000000002',
      role: 'employee',
      fullName: 'พนักงาน',
      phone: '0800000002',
    });
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
    expect(payload.aud).toBe('pos-session');
  });
});
