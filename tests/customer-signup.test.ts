// Seam under test: becoming a customer with Google, and returning as one (ADR 0020).
//
// The failure this suite exists to prevent is a split balance: a second row for a
// person whose phone already has one, with the points and the order history on whichever
// row they are not looking at. Everything here is about *one* row — created, linked, or
// refused — and never two.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ConflictError, ValidationError } from '@/lib/errors';
import { completeCustomerGoogleSignIn, findCustomerByGoogleSubject } from '@/lib/identity';
import { issueOtpChallenge } from '@/lib/otp-store';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

/** A verified Google identity, as `verifyGoogleIdToken` would return one. */
function google(subject: string, overrides: Partial<{ email: string | null; fullName: string | null }> = {}) {
  return {
    subject,
    email: overrides.email === undefined ? `${subject}@example.com` : overrides.email,
    emailVerified: true,
    fullName: overrides.fullName === undefined ? 'สมชาย จากกูเกิล' : overrides.fullName,
  };
}

/** A code that is definitely not `code`, so a wrong guess is really wrong. */
function notThis(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

const staffPhone = '0800000001'; // the admin seeded by `seedPeople`
const memberPhone = '0900000001'; // the member seeded by `seedPeople`

let memberId: string;

beforeEach(async () => {
  await resetDatabase();
  const people = await seedPeople();
  memberId = people.memberId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a first Google sign-in', () => {
  it('makes a customer for a phone nobody owns', async () => {
    const phone = '0891112222';
    const code = await issueOtpChallenge(phone);

    const result = await completeCustomerGoogleSignIn({
      identity: google('new-customer'),
      phone,
      code,
    });

    expect(result.created).toBe(true);
    expect(result.linked).toBe(false);
    expect(result.phone).toBe(phone);
    const row = await prisma.users.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.role).toBe('member');
    expect(row.google_subject).toBe('new-customer');
  });

  it('takes the Google name when the customer does not give one', async () => {
    const phone = '0891112223';
    const code = await issueOtpChallenge(phone);

    const result = await completeCustomerGoogleSignIn({ identity: google('named'), phone, code });

    const row = await prisma.users.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.full_name).toBe('สมชาย จากกูเกิล');
  });

  it('prefers the name the customer typed', async () => {
    const phone = '0891112224';
    const code = await issueOtpChallenge(phone);

    const result = await completeCustomerGoogleSignIn({
      identity: google('renamed'),
      phone,
      code,
      fullName: 'น้องใหม่',
    });

    const row = await prisma.users.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.full_name).toBe('น้องใหม่');
  });
});

describe('a Google sign-in for a phone that is already a customer', () => {
  it('links to that row, keeping the points and the history on one identity', async () => {
    await prisma.users.update({ where: { id: memberId }, data: { points_balance: 120 } });
    // A dashed form of the number, to prove it finds the challenge the counter's
    // normalised shape issued.
    const code = await issueOtpChallenge(memberPhone);

    const result = await completeCustomerGoogleSignIn({
      identity: google('returning'),
      phone: '090-000-0001',
      code,
    });

    expect(result.id).toBe(memberId);
    expect(result.linked).toBe(true);
    expect(result.created).toBe(false);
    // The row, and everything hanging off it, is unchanged — same id, same points.
    expect(result.pointsBalance).toBe(120);
    expect(await prisma.users.count({ where: { role: 'member' } })).toBe(1);
    const row = await prisma.users.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.google_subject).toBe('returning');
    expect(row.points_balance).toBe(120);
  });

  it('is a plain sign-in the second time, with no code needed', async () => {
    const first = await issueOtpChallenge(memberPhone);
    await completeCustomerGoogleSignIn({ identity: google('again'), phone: memberPhone, code: first });

    // The subject now resolves to a row, so the very first check answers — a bogus
    // code must never reach the challenge at all.
    const second = await completeCustomerGoogleSignIn({
      identity: google('again'),
      phone: memberPhone,
      code: '000000',
    });

    expect(second.id).toBe(memberId);
    expect(second.created).toBe(false);
    expect(second.linked).toBe(false);
    expect(await findCustomerByGoogleSubject('again')).toMatchObject({ id: memberId, phone: memberPhone });
  });

  it('refuses a number that belongs to staff, and attaches nothing', async () => {
    const code = await issueOtpChallenge(staffPhone);

    const failure = (await completeCustomerGoogleSignIn({
      identity: google('staff-number'),
      phone: staffPhone,
      code,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('PHONE_BELONGS_TO_STAFF');
    const staff = await prisma.users.findUniqueOrThrow({ where: { phone: staffPhone } });
    expect(staff.google_subject).toBeNull();
    expect(staff.role).toBe('admin');
  });
});

describe('one Google account, one customer', () => {
  it('refuses a second Google account on a number already linked', async () => {
    const first = await issueOtpChallenge(memberPhone);
    await completeCustomerGoogleSignIn({ identity: google('first-google'), phone: memberPhone, code: first });

    const second = await issueOtpChallenge(memberPhone);
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('second-google'),
      phone: memberPhone,
      code: second,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('GOOGLE_ACCOUNT_ALREADY_LINKED');
    const row = await prisma.users.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.google_subject).toBe('first-google');
  });

  it('refuses the same Google account for a different phone', async () => {
    const phone = '0891112225';
    const first = await issueOtpChallenge(phone);
    await completeCustomerGoogleSignIn({ identity: google('one-account'), phone, code: first });

    const second = await issueOtpChallenge('0891112226');
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('one-account'),
      phone: '0891112226',
      code: second,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('GOOGLE_ACCOUNT_ALREADY_LINKED');
    // And the second phone is still nobody's: a refusal must not half-create.
    expect(await prisma.users.findUnique({ where: { phone: '0891112226' } })).toBeNull();
  });
});

describe('the phone still has to be proved', () => {
  it('refuses a wrong code and creates nobody', async () => {
    const phone = '0891112227';
    const code = await issueOtpChallenge(phone);

    const failure = (await completeCustomerGoogleSignIn({
      identity: google('no-proof'),
      phone,
      code: notThis(code),
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
    expect(await prisma.users.findUnique({ where: { phone } })).toBeNull();
    expect(await findCustomerByGoogleSubject('no-proof')).toBeNull();
  });

  it('refuses a code that was never sent', async () => {
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('never-sent'),
      phone: '0891112228',
      code: '123456',
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
  });
});
