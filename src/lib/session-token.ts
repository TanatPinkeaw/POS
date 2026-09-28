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
 * The signing key, shared with the supervisor approval tokens.
 *
 * Exported rather than duplicated: two private copies of an `AUTH_SECRET` check
 * is two chances for one of them to be missing the length floor. Approval tokens
 * carry a different issuer and audience, so the two kinds of token cannot be
 * confused for each other even though they are signed with the same key.
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

/** Issues a signed session token for a user. */
export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ role: user.role, fullName: user.fullName, phone: user.phone })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer('pos-realtime')
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(authSecretKey());
}

/** Verifies a token and returns the user it describes. */
export async function verifySessionToken(token: string): Promise<SessionUser> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), { issuer: 'pos-realtime' });

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
