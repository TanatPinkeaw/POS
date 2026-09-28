/**
 * Password hashing.
 *
 * Deliberately separate from `auth.ts`: that module owns cookies and therefore
 * imports `next/headers`, which a route handler can use but a unit test, a seed
 * script or an import pipeline cannot. Staff creation only needs the hash, so
 * the hash lives here and `auth.ts` re-exports it for existing callers.
 */
import { compare, hash } from 'bcryptjs';

/** bcrypt cost. 10 is the conventional balance of latency and resistance. */
export const BCRYPT_ROUNDS = 10;

/** The shortest password the system will accept. */
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(plaintext: string, passwordHash: string): Promise<boolean> {
  return compare(plaintext, passwordHash);
}
