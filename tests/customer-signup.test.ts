// Seam under test: becoming a customer with Google, and returning as one (ADR 0020).
//
// A Google credential proves the Google account, and nothing about the number it
// arrives with. So the rules this suite pins are: one Google account, one customer;
// a number nobody owns makes one; and a number that already has a customer — or a
// member of staff — is refused rather than taken. The failure it exists to prevent is
// the takeover: attaching a subject to a row on the strength of a typed number.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ConflictError, ValidationError } from '@/lib/errors';
import { completeCustomerGoogleSignIn, findCustomerByGoogleSubject } from '@/lib/identity';
import { CURRENT_CUSTOMER_NOTICE_VERSION } from '@/lib/privacy-notice';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

/**
 * The version these tests acknowledge when they create a customer.
 *
 * A signup that makes an account now demands one (`identity.ts`), because that is the
 * only moment the shop can tell a customer what it does with their data. This suite is
 * about *identity* — one Google account, one customer, no takeover by typed number — so
 * it supplies the current version rather than testing the gate here; the gate's own
 * tests live in `notice-acknowledgement.test.ts`.
 */
const CURRENT_NOTICE_VERSION = CURRENT_CUSTOMER_NOTICE_VERSION;

/** A verified Google identity, as `verifyGoogleIdToken` would return one. */
function google(subject: string, overrides: Partial<{ email: string | null; fullName: string | null }> = {}) {
  return {
    subject,
    email: overrides.email === undefined ? `${subject}@example.com` : overrides.email,
    emailVerified: true,
    fullName: overrides.fullName === undefined ? 'สมชาย จากกูเกิล' : overrides.fullName,
  };
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

    const result = await completeCustomerGoogleSignIn({
      identity: google('new-customer'),
      phone,
      noticeVersion: CURRENT_NOTICE_VERSION,
    });

    expect(result.created).toBe(true);
    expect(result.phone).toBe(phone);
    const row = await prisma.users.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.role).toBe('member');
    expect(row.google_subject).toBe('new-customer');
  });

  it('takes the Google name when the customer does not give one', async () => {
    const result = await completeCustomerGoogleSignIn({
      identity: google('named'),
      phone: '0891112223',
      noticeVersion: CURRENT_NOTICE_VERSION,
    });

    const row = await prisma.users.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.full_name).toBe('สมชาย จากกูเกิล');
  });

  it('prefers the name the customer typed', async () => {
    const result = await completeCustomerGoogleSignIn({
      identity: google('renamed'),
      phone: '0891112224',
      noticeVersion: CURRENT_NOTICE_VERSION,
      fullName: 'น้องใหม่',
    });

    const row = await prisma.users.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.full_name).toBe('น้องใหม่');
  });

  it('refuses a first sign-in with no number at all', async () => {
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('no-number'),
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
    expect(await findCustomerByGoogleSubject('no-number')).toBeNull();
  });
});

describe('a number that is already somebody', () => {
  it('refuses a number the counter enrolled, rather than taking the row', async () => {
    await prisma.users.update({ where: { id: memberId }, data: { points_balance: 120 } });

    const failure = (await completeCustomerGoogleSignIn({
      identity: google('would-be-thief'),
      phone: memberPhone,
      noticeVersion: CURRENT_NOTICE_VERSION,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('PHONE_ALREADY_REGISTERED');
    // The row is exactly as the counter left it: same points, still no Google.
    const row = await prisma.users.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.points_balance).toBe(120);
    expect(row.google_subject).toBeNull();
    expect(await prisma.users.count({ where: { role: 'member' } })).toBe(1);
    expect(await findCustomerByGoogleSubject('would-be-thief')).toBeNull();
  });

  it('refuses a number written in another shape, because it is the same number', async () => {
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('dashed'),
      phone: '090-000-0001',
      noticeVersion: CURRENT_NOTICE_VERSION,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('PHONE_ALREADY_REGISTERED');
  });

  it('refuses a number that belongs to staff, and attaches nothing', async () => {
    const failure = (await completeCustomerGoogleSignIn({
      identity: google('staff-number'),
      phone: staffPhone,
      noticeVersion: CURRENT_NOTICE_VERSION,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('PHONE_BELONGS_TO_STAFF');
    const staff = await prisma.users.findUniqueOrThrow({ where: { phone: staffPhone } });
    expect(staff.google_subject).toBeNull();
    expect(staff.role).toBe('admin');
  });
});

describe('one Google account, one customer', () => {
  it('signs the same subject back in without a number', async () => {
    const phone = '0891112225';
    const first = await completeCustomerGoogleSignIn({
      identity: google('again'),
      phone,
      noticeVersion: CURRENT_NOTICE_VERSION,
    });

    // The subject now resolves to a row, so the very first check answers and the
    // number is not even read — a returning account needs none.
    const second = await completeCustomerGoogleSignIn({ identity: google('again') });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);
    expect(await findCustomerByGoogleSubject('again')).toMatchObject({ id: first.id, phone });
    expect(await prisma.users.count({ where: { role: 'member' } })).toBe(2); // seeded + this one
  });

  it('cannot be used to make a second customer on a different number', async () => {
    const first = await completeCustomerGoogleSignIn({
      identity: google('one-account'),
      phone: '0891112226',
      noticeVersion: CURRENT_NOTICE_VERSION,
    });

    // Presenting a different number while already being somebody signs straight in;
    // it never creates or moves anything. Moving a number is `changeCustomerPhone`.
    const second = await completeCustomerGoogleSignIn({
      identity: google('one-account'),
      phone: '0891112227',
      noticeVersion: CURRENT_NOTICE_VERSION,
    });

    expect(second.id).toBe(first.id);
    expect(await prisma.users.findUnique({ where: { phone: '0891112227' } })).toBeNull();
  });
});
