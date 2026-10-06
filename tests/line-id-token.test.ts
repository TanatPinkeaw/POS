// Seam under test: verifying a LINE Login id token in process, with no network.
//
// The same forgery catalogue the Google door's tests pin (ADR 0020's `tests/
// google-id-token.test.ts`), because LINE's token is the same kind of thing: a
// bearer credential a caller can craft. A valid token proves the module does its
// job at all; everything else is about what must be refused.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '@/lib/errors';
import { InvalidLineCredentialError, readLineChannelId, verifyLineIdToken } from '@/lib/line-id-token';

const CHANNEL_ID = '2000000000-test-channel';
const ISSUER = 'https://access.line.me';

/** A locally generated RSA key pair, so verification is exercised without LINE. */
let keys: Awaited<ReturnType<typeof createLocalJWKSet>>;
let signKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [await exportJWK(pair.publicKey)] });
});

/** A token as LINE would mint one, with overrides for the case under test. */
async function lineToken(overrides: {
  subject?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: number;
  claims?: Record<string, unknown>;
  key?: CryptoKey;
} = {}): Promise<string> {
  const token = new SignJWT({
    name: 'ลูกค้า ไลน์',
    email: 'customer@example.com',
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(overrides.subject ?? 'line-subject-1')
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? CHANNEL_ID)
    // Absolute seconds, so a negative `expiresIn` is a token that has already expired.
    .setExpirationTime(Math.floor(Date.now() / 1000) + (overrides.expiresIn ?? 3600));

  return token.sign(overrides.key ?? signKey);
}

function verify(token: string): Promise<unknown> {
  return verifyLineIdToken(token, { channelId: CHANNEL_ID, keys }).catch((error: unknown) => error);
}

describe('a LINE id token', () => {
  it('is accepted, and reports the identity it asserts', async () => {
    const identity = await verifyLineIdToken(await lineToken(), { channelId: CHANNEL_ID, keys });

    expect(identity).toEqual({
      subject: 'line-subject-1',
      displayName: 'ลูกค้า ไลน์',
      email: 'customer@example.com',
    });
  });

  it('names the subject the same way every time, so a returning customer is the same row', async () => {
    const first = await verifyLineIdToken(await lineToken(), { channelId: CHANNEL_ID, keys });
    const second = await verifyLineIdToken(await lineToken(), { channelId: CHANNEL_ID, keys });

    expect(first.subject).toBe(second.subject);
  });

  it('refuses a token signed by a key that is not LINE`s', async () => {
    const stranger = await generateKeyPair('RS256');
    const forged = await lineToken({ key: stranger.privateKey });

    await expect(verify(forged)).resolves.toBeInstanceOf(InvalidLineCredentialError);
  });

  it('refuses a token minted for another channel', async () => {
    // A token for somebody else's LINE Login channel must not sign anybody in here.
    const foreign = await lineToken({ audience: '2000000000-not-ours' });
    await expect(verify(foreign)).resolves.toBeInstanceOf(InvalidLineCredentialError);
  });

  it('refuses a token from another issuer — including Google`s', async () => {
    // The two doors verify different issuers; a Google token is junk here, and a
    // LINE token is junk at the Google door. One identity, one verifier.
    const googleIssued = await lineToken({ issuer: 'https://accounts.google.com' });
    await expect(verify(googleIssued)).resolves.toBeInstanceOf(InvalidLineCredentialError);
  });

  it('refuses an expired token', async () => {
    const expired = await lineToken({ expiresIn: -10 });
    await expect(verify(expired)).resolves.toBeInstanceOf(InvalidLineCredentialError);
  });

  it('refuses a symmetric token offered where an RSA one was expected', async () => {
    // The algorithm confusion attack: same claim shape, HS256 instead of RS256.
    const secret = new TextEncoder().encode('a-symmetric-secret-nobody-here-minted-64');
    const confused = await new SignJWT({ name: 'ลูกค้า ไลน์' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('line-subject-1')
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(CHANNEL_ID)
      .setExpirationTime('1h')
      .sign(secret);

    await expect(verify(confused)).resolves.toBeInstanceOf(InvalidLineCredentialError);
  });

  it('refuses a token with no subject, however valid the signature', async () => {
    const minted = await new SignJWT({ name: 'ลูกค้า ไลน์' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(CHANNEL_ID)
      .setExpirationTime('1h')
      .sign(signKey);

    await expect(verify(minted)).resolves.toBeInstanceOf(InvalidLineCredentialError);
  });

  it('refuses junk without pretending to know what it was', async () => {
    for (const junk of ['', 'not.a.token', 'a.b.c', '12345']) {
      await expect(verify(junk), junk).resolves.toBeInstanceOf(InvalidLineCredentialError);
    }
  });

  it('fails as a domain error a sign-in screen can read, not a 500', async () => {
    const failure = (await verify('not.a.token')) as DomainError;

    expect(failure).toBeInstanceOf(DomainError);
    expect(failure.httpStatus).toBe(401);
    expect(failure.code).toBe('INVALID_LINE_CREDENTIAL');
  });

  it('refuses to verify when this deployment has no channel id', async () => {
    await expect(verifyLineIdToken(await lineToken(), { env: {} })).rejects.toBeInstanceOf(
      InvalidLineCredentialError,
    );
  });
});

describe('the configured LINE channel id', () => {
  it('is nothing when unset or blank', () => {
    expect(readLineChannelId({})).toBeNull();
    expect(readLineChannelId({ LINE_LOGIN_CHANNEL_ID: '   ' })).toBeNull();
  });

  it('is trimmed when set', () => {
    expect(readLineChannelId({ LINE_LOGIN_CHANNEL_ID: ' 2001234567 ' })).toBe('2001234567');
  });
});
