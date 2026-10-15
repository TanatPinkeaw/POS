/**
 * A LINE key set a script owns, and the LIFF id tokens it can mint.
 *
 * The LIFF entry posts an id token to `POST /api/v1/auth/line`, and that route verifies it
 * with **ES256 against LINE's published EC keys** (ADR 0030 §5) — the native/SDK/LIFF
 * algorithm, which is a different key source from the web flow's HS256 channel secret. So a
 * script that wants to walk that door has to *be* LINE: it points `LINE_JWKS_URL` at a
 * listener this process serves and mints with a key it generated. The same trade the OTP
 * gateway, the LINE token endpoint and Google's key set already make, and the reason no leg
 * of a run here depends on somebody else's uptime.
 *
 * It lives beside `google-stub.ts` rather than inside the one script that uses it today, for
 * the reason that file gives: the alternative is two copies of "an EC key pair and the JWKS
 * document for it", and the **second** copy is the one that gets the `kid` wrong. Nothing here
 * knows anything about customers, orders or this application — it is a stub for a third party,
 * not a second implementation of the thing under test.
 */
import { createServer, type Server } from 'node:http';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { freePort } from './harness';

/** The channel id every token this stub mints carries, and what the app is configured with. */
export const LINE_STUB_CHANNEL_ID = '2000000000';

/** The LIFF app id a test deployment is configured with; never a real one. */
export const LINE_STUB_LIFF_ID = '2000000000-liffstub';

export interface LineStub {
  /** The audience every token this stub mints carries (`LINE_LOGIN_CHANNEL_ID`). */
  channelId: string;
  /** The key set document, for `LINE_JWKS_URL`. */
  jwksUrl: string;
  /** An ES256 id token this deployment will accept, for one LINE subject. */
  mintIdToken(
    subject: string,
    /**
     * `channelId` is the control: a token minted for a *different* channel is one this deployment
     * must refuse, and only a token with the wrong audience can show that the check exists. A stub
     * that could only mint acceptable tokens would let a verifier that accepts anything pass
     * every check in the run that uses it.
     */
    overrides?: { displayName?: string; email?: string; channelId?: string },
  ): Promise<string>;
  close(): Promise<void>;
}

/**
 * Starts the key set and returns the minter.
 *
 * The keys are generated per run rather than committed, so nothing in this repository is a
 * credential and a token minted by one run cannot be replayed against another. The `kid` is
 * advertised in the JWKS and named in every token's protected header, because that is the pair
 * `jose` matches on: a stub that signed with a key the key set does not name would fail to
 * verify for a reason that looks exactly like a verifier bug.
 */
export async function startLineStub(
  channelId = LINE_STUB_CHANNEL_ID,
): Promise<LineStub> {
  const pair = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(pair.publicKey);
  const kid = 'liff-stub-key';
  const port = await freePort(3461);
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }] }));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    channelId,
    jwksUrl: `http://127.0.0.1:${port}/oauth2/v2.1/certs`,
    async mintIdToken(subject, overrides = {}) {
      return new SignJWT({
        name: overrides.displayName ?? 'ลูกค้า เหลี่ยมนอก',
        email: overrides.email ?? `${subject}@example.com`,
      })
        .setProtectedHeader({ alg: 'ES256', kid })
        .setSubject(subject)
        .setIssuedAt()
        // LINE's one issuer, which `line-id-token.ts` pins — a stub that invented its own
        // would prove nothing about the verifier this deployment actually runs.
        .setIssuer('https://access.line.me')
        .setAudience(overrides.channelId ?? channelId)
        .setExpirationTime('1h')
        .sign(pair.privateKey);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
