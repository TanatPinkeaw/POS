/**
 * Where a phone-ownership challenge lives (ADR 0020 §5).
 *
 * The policy and the provider seam are in `otp.ts`; this file is the part that
 * cannot be pure — a row, a bcrypt hash, and a clock. One row per phone, replaced on
 * every issue, so there is exactly one live code for a number: a second send
 * invalidates the first rather than leaving two codes that both work.
 *
 * The code is stored hashed. Six digits is one million values, which is nothing to
 * someone holding the table — a plaintext column would hand them the whole space in
 * one leak. bcrypt, the same as a password, because the *secret* is the same kind of
 * thing even when the value is shorter.
 *
 * Checking is deliberately fail-closed on every axis: no row, an expired row, a
 * consumed row and a row out of attempts all answer `false`, so a caller cannot
 * learn which of those it was. The attempt counter is what turns the million-value
 * space into something a challenge can survive for its few minutes.
 */
import { compare, hash } from 'bcryptjs';

import { prisma } from './db';
import { OTP_MAX_ATTEMPTS, generateOtpCode, isOtpCodeShaped, otpCodeExpiry } from './otp';
import { BCRYPT_ROUNDS } from './password';

/**
 * Issues a fresh challenge for a phone and returns the *plaintext* code.
 *
 * Returns the code so the caller can deliver it; it is never read back out of the
 * database, because only its hash is stored. Replacing any existing row (rather than
 * inserting a second) is the whole reason this is an upsert: a customer who taps
 * "send again" must have one working code, not two.
 */
export async function issueOtpChallenge(phone: string, now: Date = new Date()): Promise<string> {
  const code = generateOtpCode();
  const codeHash = await hash(code, BCRYPT_ROUNDS);
  const expiresAt = otpCodeExpiry(now);

  await prisma.otp_challenges.upsert({
    where: { phone },
    create: { phone, code_hash: codeHash, attempts: 0, expires_at: expiresAt, consumed_at: null, created_at: now },
    update: {
      code_hash: codeHash,
      attempts: 0,
      expires_at: expiresAt,
      consumed_at: null,
      created_at: now,
    },
  });

  return code;
}

/**
 * Checks a code against the live challenge for a phone, consuming it on success.
 *
 * Success is an *atomic* claim on the row: the `consumed_at` write is conditional on
 * the row still being unconsumed, unexpired and within its attempt budget, so two
 * requests presenting the same correct code cannot both win. That matters because
 * ticket 02 turns this `true` into attaching a Google identity or completing a
 * signup, and a code that works twice is a code that can attach twice.
 */
export async function consumeOtpChallenge(
  phone: string,
  code: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await prisma.otp_challenges.findUnique({ where: { phone } });
  if (
    !row ||
    row.consumed_at !== null ||
    row.expires_at.getTime() <= now.getTime() ||
    row.attempts >= OTP_MAX_ATTEMPTS
  ) {
    return false;
  }

  // A wrong shape cannot match, but it still spends an attempt — otherwise a caller
  // could probe endlessly with malformed input at no cost.
  if (isOtpCodeShaped(code) && (await compare(code.trim(), row.code_hash))) {
    const claimed = await prisma.otp_challenges.updateMany({
      where: {
        phone,
        consumed_at: null,
        expires_at: { gt: now },
        attempts: { lt: OTP_MAX_ATTEMPTS },
      },
      data: { consumed_at: now },
    });
    return claimed.count === 1;
  }

  await prisma.otp_challenges.update({
    where: { phone },
    data: { attempts: { increment: 1 } },
  });
  return false;
}

/** Forgets a phone's challenge, so a signup flow can clear one it no longer needs. */
export async function forgetOtpChallenge(phone: string): Promise<void> {
  await prisma.otp_challenges.deleteMany({ where: { phone } });
}
