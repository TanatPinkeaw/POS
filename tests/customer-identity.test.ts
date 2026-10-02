// Seam under test: the two rows a customer identity hangs off (ADR 0020), against a
// real PostgreSQL server.
//
// The verification of a Google token is pure and pinned in
// `google-id-token.test.ts`. What can only be tested here is the storage the
// identity rests on: that a Google subject belongs to exactly one customer, and that
// a phone challenge is one live code that is replaced on a second send, dies when it
// is used, and dies when it is guessed at too often.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { OTP_MAX_ATTEMPTS } from '@/lib/otp';
import { consumeOtpChallenge, forgetOtpChallenge, issueOtpChallenge } from '@/lib/otp-store';

import { prisma, resetDatabase } from './helpers/test-db';

const PHONE = '0812345678';

/** A code that is definitely not `code`, so a wrong guess is really wrong. */
function notThis(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('one Google account, one customer', () => {
  it('refuses to attach a subject that already belongs to another row', async () => {
    await prisma.users.create({
      data: { phone: '0800000001', password_hash: 'x', full_name: 'A', google_subject: 'google-sub-1' },
    });

    await expect(
      prisma.users.create({
        data: { phone: '0800000002', password_hash: 'x', full_name: 'B', google_subject: 'google-sub-1' },
      }),
    ).rejects.toThrow();
  });

  it('lets any number of customers share the "no Google identity" state', async () => {
    // The unique index must not collide on NULL, or every counter-enrolled customer
    // after the first would be refused a row.
    await prisma.users.create({ data: { phone: '0800000003', password_hash: 'x', full_name: 'C' } });
    await prisma.users.create({ data: { phone: '0800000004', password_hash: 'x', full_name: 'D' } });

    expect(await prisma.users.count({ where: { google_subject: null } })).toBe(2);
  });
});

describe('a phone-ownership challenge', () => {
  it('round-trips a fresh code once', async () => {
    const code = await issueOtpChallenge(PHONE);

    expect(await consumeOtpChallenge(PHONE, code)).toBe(true);
    // Once, not twice: a code that works again is a code that can attach again.
    expect(await consumeOtpChallenge(PHONE, code)).toBe(false);
  });

  it('keeps a wrong guess from spending the right code', async () => {
    const code = await issueOtpChallenge(PHONE);

    expect(await consumeOtpChallenge(PHONE, notThis(code))).toBe(false);
    // One wasted attempt, and the real code still works.
    expect(await consumeOtpChallenge(PHONE, code)).toBe(true);
  });

  it('refuses a code after its lifetime', async () => {
    const issuedAt = new Date('2026-10-02T07:00:00.000Z');
    const code = await issueOtpChallenge(PHONE, issuedAt);

    // Six minutes later, with the default five-minute life.
    expect(await consumeOtpChallenge(PHONE, code, new Date(issuedAt.getTime() + 6 * 60_000))).toBe(false);
  });

  it('dies after the attempt ceiling', async () => {
    const code = await issueOtpChallenge(PHONE);

    for (let attempt = 0; attempt < OTP_MAX_ATTEMPTS; attempt += 1) {
      expect(await consumeOtpChallenge(PHONE, notThis(code)), `attempt ${attempt}`).toBe(false);
    }

    // The right code, offered after the budget is spent, is refused: exhausting a
    // challenge must cost more than the one-in-a-million guess.
    expect(await consumeOtpChallenge(PHONE, code)).toBe(false);
  });

  it('replaces the previous code when a new one is sent', async () => {
    const first = await issueOtpChallenge(PHONE);
    let second = await issueOtpChallenge(PHONE);
    while (second === first) {
      second = await issueOtpChallenge(PHONE);
    }

    // Only the newest code works — a "send again" does not leave two live codes.
    expect(await consumeOtpChallenge(PHONE, first)).toBe(false);
    expect(await consumeOtpChallenge(PHONE, second)).toBe(true);
  });

  it('answers false for a phone that was never sent a code', async () => {
    expect(await consumeOtpChallenge('0899999999', '123456')).toBe(false);
  });

  it('can be forgotten, so a flow can clear one it no longer needs', async () => {
    const code = await issueOtpChallenge(PHONE);
    await forgetOtpChallenge(PHONE);

    expect(await consumeOtpChallenge(PHONE, code)).toBe(false);
  });
});
