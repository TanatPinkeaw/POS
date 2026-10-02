// Seam under test: verifying a Google id token in-process, with no network.
//
// It is a bearer credential a caller can craft, so the tests are mostly about what
// must be refused: a token signed by somebody else, one minted for another app, one
// that has expired, and — the classic — a symmetric token offered where an
// asymmetric one was expected. A valid token proves the module does its job at all.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '@/lib/errors';
import { InvalidGoogleCredentialError, readGoogleClientId, verifyGoogleIdToken } from '@/lib/google-id-token';

const CLIENT_ID = 'pos-test.apps.googleusercontent.com';
const ISSUER = 'https://accounts.google.com';

/** A locally generated RSA key pair, so verification is exercised without Google. */
let keys: Awaited<ReturnType<typeof createLocalJWKSet>>;
let signKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  signKey = pair.privateKey;
  keys = createLocalJWKSet({ keys: [await exportJWK(pair.publicKey)] });
});

/** A token as Google would mint one, with overrides for the case under test. */
async function googleToken(overrides: {
  subject?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: number;
  claims?: Record<string, unknown>;
  key?: CryptoKey;
} = {}): Promise<string> {
  const token = new SignJWT({
    email: 'customer@example.com',
    email_verified: true,
    name: 'ลูกค้า ทดสอบ',
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject(overrides.subject ?? 'google-subject-1')
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? CLIENT_ID)
    // Absolute seconds, so a negative `expiresIn` is a token that has already expired.
    .setExpirationTime(Math.floor(Date.now() / 1000) + (overrides.expiresIn ?? 3600));

  return token.sign(overrides.key ?? signKey);
}

function verify(token: string): Promise<unknown> {
  return verifyGoogleIdToken(token, { clientId: CLIENT_ID, keys }).catch((error: unknown) => error);
}

describe('a Google id token', () => {
  it('is accepted, and reports the identity it asserts', async () => {
    const identity = await verifyGoogleIdToken(await googleToken(), { clientId: CLIENT_ID, keys });

    expect(identity).toEqual({
      subject: 'google-subject-1',
      email: 'customer@example.com',
      emailVerified: true,
      fullName: 'ลูกค้า ทดสอบ',
    });
  });

  it('names the subject the same way every time, so a returning customer is the same row', async () => {
    const first = await verifyGoogleIdToken(await googleToken(), { clientId: CLIENT_ID, keys });
    const second = await verifyGoogleIdToken(await googleToken(), { clientId: CLIENT_ID, keys });

    expect(first.subject).toBe(second.subject);
  });

  it('refuses a token signed by a key that is not Google`s', async () => {
    const stranger = await generateKeyPair('RS256');
    const forged = await googleToken({ key: stranger.privateKey });

    await expect(verify(forged)).resolves.toBeInstanceOf(InvalidGoogleCredentialError);
  });

  it('refuses a token minted for another application', async () => {
    // The whole reason `aud` exists: a token for somebody else's Google app must not
    // sign anybody in here.
    const foreign = await googleToken({ audience: 'someone-else.apps.googleusercontent.com' });
    await expect(verify(foreign)).resolves.toBeInstanceOf(InvalidGoogleCredentialError);
  });

  it('refuses a token from another issuer', async () => {
    const foreign = await googleToken({ issuer: 'https://evil.example.com' });
    await expect(verify(foreign)).resolves.toBeInstanceOf(InvalidGoogleCredentialError);
  });

  it('refuses an expired token', async () => {
    const expired = await googleToken({ expiresIn: -10 });
    await expect(verify(expired)).resolves.toBeInstanceOf(InvalidGoogleCredentialError);
  });

  it('refuses a symmetric token offered where an RSA one was expected', async () => {
    // The algorithm confusion attack: same claim shape, HS256 instead of RS256. It
    // fails because the allowed algorithms are pinned, not inferred.
    const secret = new TextEncoder().encode('a-symmetric-secret-nobody-here-minted-64');
    const confused = await new SignJWT({ email: 'customer@example.com', email_verified: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('google-subject-1')
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime('1h')
      .sign(secret);

    await expect(verify(confused)).resolves.toBeInstanceOf(InvalidGoogleCredentialError);
  });

  it('refuses a token with no subject, however valid the signature', async () => {
    const minted = await new SignJWT({ email: 'customer@example.com' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime('1h')
      .sign(signKey);

    await expect(verify(minted)).resolves.toBeInstanceOf(InvalidGoogleCredentialError);
  });

  it('refuses junk without pretending to know what it was', async () => {
    for (const junk of ['', 'not.a.token', 'a.b.c', '12345']) {
      await expect(verify(junk), junk).resolves.toBeInstanceOf(InvalidGoogleCredentialError);
    }
  });

  it('fails as a domain error a sign-in screen can read, not a 500', async () => {
    const failure = (await verify('not.a.token')) as DomainError;

    expect(failure).toBeInstanceOf(DomainError);
    expect(failure.httpStatus).toBe(401);
    expect(failure.code).toBe('INVALID_GOOGLE_CREDENTIAL');
  });

  it('refuses to verify when this deployment has no Google client id', async () => {
    await expect(
      verifyGoogleIdToken(await googleToken(), { env: {} }),
    ).rejects.toBeInstanceOf(InvalidGoogleCredentialError);
  });
});

describe('the configured Google client id', () => {
  it('is nothing when unset or blank', () => {
    expect(readGoogleClientId({})).toBeNull();
    expect(readGoogleClientId({ GOOGLE_CLIENT_ID: '   ' })).toBeNull();
  });

  it('is trimmed when set', () => {
    expect(readGoogleClientId({ GOOGLE_CLIENT_ID: ' abc.apps.googleusercontent.com ' })).toBe(
      'abc.apps.googleusercontent.com',
    );
  });
});
