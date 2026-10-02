/**
 * Verifying a Google sign-in id token (ADR 0020 §6).
 *
 * When a customer continues with Google, the browser hands back a signed **id
 * token** — a JWT that Google signed with an RSA key. It is verified here, in
 * process, against Google's published JWKS, with `jose` (already a dependency of
 * this repository: the session token and the pickup code use it). The alternative —
 * POSTing the token to Google's `tokeninfo` endpoint — is defensible but couples
 * every sign-in to a network round trip and to Google's rate limits, for no crypto
 * we do not already have.
 *
 * Three properties, and each one is a decision:
 *
 *   * **The signature is checked against the published keys, and the algorithm is
 *     pinned to RS256.** A token is never trusted for having arrived over TLS: an
 *     id token is a bearer credential a caller can craft, and `algorithms: ['RS256']`
 *     is what stops the classic confusion of a symmetric key being accepted where an
 *     asymmetric one was expected.
 *   * **The audience is this deployment's client id.** Without it, a token minted for
 *     *another* Google app would be accepted as a sign-in here, which is the whole
 *     reason `aud` exists.
 *   * **The issuer is Google's.** Both the `accounts.google.com` and the
 *     scheme-qualified forms are accepted, because Google has used each and which one
 *     appears has changed over time.
 *
 * The subject id it returns is what is stored on `users.google_subject` (unique), so
 * a returning Google account resolves to the same customer rather than a second row.
 * The phone is still the identity (ADR 0020 §2) — this module only proves the Google
 * credential; proving the phone is `otp.ts`, and linking the two is ticket 02.
 */
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';

import { DomainError } from './errors';

/** Google publishes its signing keys here; the key set is cached and rotated by jose. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Both forms Google has used in `iss`; either is accepted. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Raised when a presented id token is not a Google credential we will accept.
 *
 * One answer covers a bad signature, a wrong audience, an expired token and a piece
 * of junk — telling them apart would only help somebody probing what is wrong with
 * their forgery. A `DomainError` (401), so `withApi` returns a sign-in refusal rather
 * than a 500.
 */
export class InvalidGoogleCredentialError extends DomainError {
  constructor(message = 'Google sign-in could not be verified') {
    super(message, 'INVALID_GOOGLE_CREDENTIAL', 401);
  }
}

/** What a verified id token tells us about the person, and all it tells us. */
export interface GoogleIdentity {
  /** Google's stable, per-account subject id — what goes on `users.google_subject`. */
  subject: string;
  email: string | null;
  /** Google asserts this for its own accounts; kept so a caller can insist on it. */
  emailVerified: boolean;
  fullName: string | null;
}

/** This deployment's Google client id, or null when Google sign-in is unconfigured. */
export function readGoogleClientId(env: Record<string, string | undefined> = process.env): string | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  return clientId && clientId.length > 0 ? clientId : null;
}

/** The remote key set, created once per process and reused across sign-ins. */
let remoteJwks: JWTVerifyGetKey | null = null;

function googleJwks(): JWTVerifyGetKey {
  remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return remoteJwks;
}

/**
 * Verifies a Google id token and returns the identity it asserts.
 *
 * `clientId` and `keys` are injectable so a test can verify against a locally
 * generated key pair instead of Google's live JWKS — the network is not part of what
 * this module proves.
 */
export async function verifyGoogleIdToken(
  token: string,
  options: { clientId?: string; keys?: JWTVerifyGetKey; env?: Record<string, string | undefined> } = {},
): Promise<GoogleIdentity> {
  const clientId = options.clientId ?? readGoogleClientId(options.env);
  if (!clientId) {
    throw new InvalidGoogleCredentialError(
      'GOOGLE_CLIENT_ID is not set, so a Google sign-in cannot be accepted',
    );
  }

  try {
    const { payload } = await jwtVerify(token, options.keys ?? googleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: clientId,
      algorithms: ['RS256'],
    });

    const { sub, email, email_verified, name } = payload as JWTPayload & Record<string, unknown>;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new InvalidGoogleCredentialError();
    }

    return {
      subject: sub,
      email: typeof email === 'string' ? email : null,
      emailVerified: email_verified === true,
      fullName: typeof name === 'string' ? name : null,
    };
  } catch (error) {
    if (error instanceof InvalidGoogleCredentialError) {
      throw error;
    }
    throw new InvalidGoogleCredentialError();
  }
}
