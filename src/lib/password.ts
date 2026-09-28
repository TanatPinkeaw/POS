/**
 * Password hashing, and the rule about what a password may be.
 *
 * Deliberately separate from `auth.ts`: that module owns cookies and therefore
 * imports `next/headers`, which a route handler can use but a unit test, a seed
 * script or an import pipeline cannot. Staff creation only needs the hash, so
 * the hash lives here and `auth.ts` re-exports it for existing callers.
 *
 * The *rule* lives here for the same reason the hash does: three surfaces now
 * hand somebody a temporary password — the setup wizard, the staff screen and the
 * member screen — and a length that is stated in three places is a length that is
 * three different numbers within a year.
 */
import { compare, hash } from 'bcryptjs';

import { ValidationError } from './errors';

/** bcrypt cost. 10 is the conventional balance of latency and resistance. */
export const BCRYPT_ROUNDS = 10;

/** The shortest password the system will accept. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * What is wrong with this password, or `null` when nothing is.
 *
 * Returns the message rather than throwing so a form can put it next to the
 * field; `assertPassword` is the same rule for a caller that has nothing to do
 * with it.
 *
 * No composition rules (a digit, a capital, a symbol) on purpose. They push
 * people towards `Password1!` and away from a passphrase, and the length is the
 * part that actually costs an attacker something.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

/** Refuses a password the whole system would have to disagree with later. */
export function assertPassword(password: string): void {
  const problem = passwordProblem(password);
  if (problem) {
    throw new ValidationError(problem);
  }
}

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(plaintext: string, passwordHash: string): Promise<boolean> {
  return compare(plaintext, passwordHash);
}
