/**
 * Verifying a LINE Login id token (ADR 0030 §5).
 *
 * The same shape as `google-id-token.ts`, because the problem is the same problem:
 * the browser hands back a signed **id token** a caller could have crafted, so it is
 * verified here, in process, against the issuer's published JWKS, with `jose` — a
 * dependency of this repository already. Nothing is trusted for having arrived over
 * TLS.
 *
 * Where Google's module pins RS256 against Google's keys, this one pins RS256
 * against LINE's, and LINE's issuer is written one way — `https://access.line.me` —
 * rather than Google's two. The subject it returns is what lands on
 * `users.line_subject` (unique), so a returning LINE account resolves to the same
 * customer rather than a second row. The email inside the token is carried so the
 * signup can store it, and is never trusted for *linking*: the proof that a number
 * is held is the OTP consumed against it, not an address somebody else may also
 * hold (ADR 0030 §1, §5).
 */
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';

import { DomainError } from './errors';

/** LINE publishes its signing keys here; the key set is cached and rotated by jose. */
export const LINE_JWKS_URL = 'https://api.line.me/oauth2/v2.1/certs';

/**
 * The key set to verify against — LINE's, unless the operator overrides it.
 *
 * The same two honest reasons and one dangerous one as the Google module's
 * override: the acceptance run points it at a JWKS it serves itself, an egress
 * proxy can mirror the keys, and whoever sets it moves the trust anchor — which is
 * why only the operator sets it, from the same `.env` they already keep secrets in.
 */
export function readLineJwksUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.LINE_JWKS_URL?.trim();
  return url && url.length > 0 ? url : LINE_JWKS_URL;
}

/** The one issuer LINE Login has used. */
const LINE_ISSUER = 'https://access.line.me';

/**
 * Raised when a presented id token is not a LINE credential we will accept.
 *
 * One answer covers a bad signature, a wrong audience, an expired token and junk —
 * telling them apart only helps somebody probing their forgery. A `DomainError`
 * (401), so `withApi` returns a sign-in refusal rather than a 500.
 */
export class InvalidLineCredentialError extends DomainError {
  constructor(message = 'การเข้าสู่ระบบด้วย LINE ไม่สำเร็จ — โปรดลองอีกครั้ง') {
    super(message, 'INVALID_LINE_CREDENTIAL', 401);
  }
}

/** What a verified id token tells us about the person, and all it tells us. */
export interface LineIdentity {
  /** LINE's stable per-user id — what goes on `users.line_subject`. */
  subject: string;
  /** The `sub` is also the address a Messaging API push is sent to. */
  displayName: string | null;
  /** Carried for storage on signup; never trusted for linking (ADR 0030 §5). */
  email: string | null;
}

/** This deployment's LINE Login channel id, or null when the door is unconfigured. */
export function readLineChannelId(env: Record<string, string | undefined> = process.env): string | null {
  const channelId = env.LINE_LOGIN_CHANNEL_ID?.trim();
  return channelId && channelId.length > 0 ? channelId : null;
}

/**
 * The remote key set, cached per URL and reused across sign-ins.
 *
 * Keyed by URL rather than a single slot because the acceptance run changes the
 * URL between phases; a plain `??=` would keep serving the first set it built.
 */
let remoteJwks: { url: string; keys: JWTVerifyGetKey } | null = null;

function lineJwks(url: string): JWTVerifyGetKey {
  if (remoteJwks?.url !== url) {
    remoteJwks = { url, keys: createRemoteJWKSet(new URL(url)) };
  }
  return remoteJwks.keys;
}

/**
 * Verifies a LINE id token and returns the identity it asserts.
 *
 * `channelId` and `keys` are injectable so a test can verify against a locally
 * generated key pair instead of LINE's live JWKS — the network is not part of what
 * this module proves.
 */
export async function verifyLineIdToken(
  token: string,
  options: { channelId?: string; keys?: JWTVerifyGetKey; env?: Record<string, string | undefined> } = {},
): Promise<LineIdentity> {
  const channelId = options.channelId ?? readLineChannelId(options.env);
  if (!channelId) {
    throw new InvalidLineCredentialError(
      'LINE_LOGIN_CHANNEL_ID is not set, so a LINE sign-in cannot be accepted',
    );
  }

  try {
    const { payload } = await jwtVerify(token, options.keys ?? lineJwks(readLineJwksUrl(options.env)), {
      issuer: LINE_ISSUER,
      audience: channelId,
      algorithms: ['RS256'],
    });

    const { sub, name, email } = payload as JWTPayload & Record<string, unknown>;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new InvalidLineCredentialError();
    }

    return {
      subject: sub,
      displayName: typeof name === 'string' ? name : null,
      email: typeof email === 'string' ? email : null,
    };
  } catch (error) {
    if (error instanceof InvalidLineCredentialError) {
      throw error;
    }
    throw new InvalidLineCredentialError();
  }
}
