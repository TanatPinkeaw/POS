/**
 * Server-side authentication.
 *
 * A deliberately small homegrown session: bcrypt password hashes plus a signed
 * JWT in an httpOnly cookie. That is the whole mechanism, which keeps the
 * dependency surface (and the amount of behaviour a reviewer must trust) small.
 */
import { compare, hash } from 'bcryptjs';
import { cookies } from 'next/headers';

import { prisma } from './db';
import { ForbiddenError, UnauthenticatedError } from './errors';
import type { Role } from './roles';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  type SessionUser,
  createSessionToken,
  verifySessionToken,
} from './session-token';

/** bcrypt cost. 10 is the conventional balance of latency and resistance. */
const BCRYPT_ROUNDS = 10;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(plaintext: string, passwordHash: string): Promise<boolean> {
  return compare(plaintext, passwordHash);
}

/** Signs a user in by writing the session cookie. */
export async function startSession(user: SessionUser): Promise<void> {
  const token = await createSessionToken(user);
  const store = await cookies();

  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Clears the session cookie. */
export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

/** The signed-in user as described by the cookie, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  try {
    return await verifySessionToken(token);
  } catch {
    // A tampered or expired cookie is simply "not signed in".
    return null;
  }
}

/** Requires any authenticated user, returning the token's claims. */
export async function requireUser(): Promise<SessionUser> {
  const session = await getSessionUser();
  if (!session) {
    throw new UnauthenticatedError();
  }
  return session;
}

/**
 * Requires the caller to hold one of `roles`.
 *
 * The role comes from the signed token, never from the request body, so a
 * member cannot promote themselves by editing a payload.
 */
export async function requireRole(roles: Role[]): Promise<SessionUser> {
  const session = await requireUser();
  if (!roles.includes(session.role)) {
    throw new ForbiddenError(
      `This action requires one of: ${roles.join(', ')}. You are signed in as ${session.role}.`,
    );
  }
  return session;
}

/**
 * Loads the live user row behind a session.
 *
 * Used where a stale claim would be dangerous — a deactivated account must stop
 * working even while its token is still valid.
 */
export async function requireActiveUser(): Promise<{
  session: SessionUser;
  user: {
    id: string;
    role: Role;
    full_name: string;
    phone: string;
    points_balance: number;
  };
}> {
  const session = await requireUser();

  const user = await prisma.users.findUnique({
    where: { id: session.id },
    select: { id: true, role: true, full_name: true, phone: true, points_balance: true, is_active: true },
  });

  if (!user || !user.is_active) {
    throw new UnauthenticatedError('This account is no longer active');
  }

  return {
    session,
    user: {
      id: user.id,
      role: user.role as Role,
      full_name: user.full_name,
      phone: user.phone,
      points_balance: user.points_balance,
    },
  };
}
