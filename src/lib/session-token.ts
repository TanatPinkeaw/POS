/**
 * Session token minting and verification.
 *
 * Node-free on purpose: this module is imported by `middleware.ts`, which runs
 * on the edge runtime where `bcryptjs` and Prisma are unavailable. Everything
 * that needs the database lives in `auth.ts` instead.
 */
import { SignJWT, jwtVerify } from 'jose';

import type { Role } from './roles';

export const SESSION_COOKIE_NAME = 'pos_session';

/** Sessions last a working day; staff re-authenticate each shift. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface SessionUser {
  id: string;
  role: Role;
  fullName: string;
  phone: string;
}

/** Raised when a token is absent, malformed, expired, or signed with another key. */
export class InvalidSessionError extends Error {
  constructor(message = 'Invalid or expired session') {
    super(message);
    this.name = 'InvalidSessionError';
  }
}

/**
 * The signing key, shared with every other token this app mints — supervisor
 * approvals, pickup codes, receipt links, the LINE callback's state.
 *
 * Exported rather than duplicated: two private copies of an `AUTH_SECRET` check
 * is two chances for one of them to be missing the length floor. One key means a
 * signature alone proves nothing about *which kind* a token is, so every family
 * must pin its own issuer and audience and every verifier must check both. The
 * session family was the last to skip the audience half — its verifier accepted
 * any same-key token carrying a string `role` field, which is to say its only
 * defence against the pickup and receipt families was that their payloads
 * happen not to have one. Found by the security audit; see
 * `tests/session-token-audience.test.ts` for the shape that must stay refused.
 */
export function authSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET must be set to a string of at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return new TextEncoder().encode(secret);
}

const SESSION_ISSUER = 'pos-realtime';
/**
 * This family's own audience — the claim that separates a session from every
 * other token minted under the shared key. Mints under the old shape (no
 * audience, issued before this was added) stop verifying the moment it lands,
 * which is deliberate: a session is 12 hours, so the migration costs every
 * holder one re-login, and the alternative was keeping a verifier that cannot
 * tell a session from a pickup code without reading its payload.
 */
const SESSION_AUDIENCE = 'pos-session';

/** Issues a signed session token for a user. */
export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ role: user.role, fullName: user.fullName, phone: user.phone })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(authSecretKey());
}

/** Verifies a token and returns the user it describes. */
export async function verifySessionToken(token: string): Promise<SessionUser> {
  try {
    // Both claims, always. The issuer alone is shared by every token family
    // under this key, so it discriminates nothing; the audience is the check.
    const { payload } = await jwtVerify(token, authSecretKey(), {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });

    const { sub, role, fullName, phone } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof role !== 'string') {
      throw new InvalidSessionError();
    }

    return {
      id: sub,
      role: role as Role,
      fullName: typeof fullName === 'string' ? fullName : '',
      phone: typeof phone === 'string' ? phone : '',
    };
  } catch (error) {
    if (error instanceof InvalidSessionError) {
      throw error;
    }
    throw new InvalidSessionError();
  }
}
