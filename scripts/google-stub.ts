/**
 * A Google key set a script owns, and the id tokens it can mint.
 *
 * The Google door verifies an id token against Google's *published* JWKS, so a script that
 * wants to walk that door has to be Google. Two do: `acceptance.ts`, which drives the door
 * over HTTP and needs a token that verifies, and `google-door-browser.ts`, which drives the
 * redirect landing from a real browser. Both point `GOOGLE_JWKS_URL` at a listener this
 * process serves and mint with a key it generated — the same trade the OTP gateway and the
 * LINE token endpoint make, and the reason no leg of either run depends on somebody else's
 * uptime.
 *
 * It lives here rather than in one of those scripts because the alternative is two copies
 * of "an RS256 key pair and the JWKS document for it", and the *second* copy is the one
 * that gets the `kid` wrong. Nothing in this file knows anything about orders, sign-in or
 * this application: it is a stub for a third party, not a second implementation of the
 * thing under test.
 */
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { freePort } from './harness';

export interface GoogleStub {
  /** The audience every token this stub mints carries, and what the app is configured with. */
  clientId: string;
  /** The key set document, for `GOOGLE_JWKS_URL`. */
  jwksUrl: string;
  /** An id token this deployment will accept, for one subject. */
  mintIdToken(subject: string, overrides?: { fullName?: string; email?: string }): Promise<string>;
  close(): Promise<void>;
}

/** The client id a test deployment is configured with; never a real one. */
export const GOOGLE_STUB_CLIENT_ID = 'acceptance.apps.googleusercontent.com';

/**
 * Starts the key set and returns the minter.
 *
 * The keys are generated per run rather than committed, so nothing in this repository is a
 * credential, and a token minted by one run cannot be replayed against another.
 */
export async function startGoogleStub(clientId = GOOGLE_STUB_CLIENT_ID): Promise<GoogleStub> {
  const pair = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(pair.publicKey);
  const port = await freePort(3451);
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: 'stub-key', use: 'sig' }] }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    clientId,
    jwksUrl: `http://127.0.0.1:${port}/certs`,
    async mintIdToken(subject, overrides = {}) {
      return new SignJWT({
        email: overrides.email ?? `${subject}@example.com`,
        email_verified: true,
        name: overrides.fullName ?? 'ลูกค้า กูเกิล',
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject(subject)
        .setIssuedAt()
        .setIssuer('https://accounts.google.com')
        .setAudience(clientId)
        .setExpirationTime('1h')
        .sign(pair.privateKey);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
