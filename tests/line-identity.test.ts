// Seam under test: the rows a LINE identity hangs off (ADR 0030), against a real
// PostgreSQL server.
//
// The verification of the token is pure and pinned in `line-id-token.test.ts`.
// What can only be tested here is the storage the binding rests on: that one LINE
// account belongs to exactly one customer, that a first sign-in consumes an OTP
// before writing, that a staff number is never bound, and that unbinding clears
// the subject and the consent together.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bindLineToCustomer,
  bindSignedInCustomer,
  findCustomerByLineSubject,
  lineBindingForUser,
  setLineNotificationConsent,
  unbindLineFromCustomer,
} from '@/lib/line-identity';
import { issueOtpChallenge } from '@/lib/otp-store';
import { CURRENT_CUSTOMER_NOTICE_VERSION } from '@/lib/privacy-notice';
import { resetDatabase, seedPeople } from './helpers/test-db';
import { prisma } from './helpers/test-db';

const PHONE = '0865550001';
const SUBJECT = 'Uline-customer-1';

beforeEach(async () => {
  await resetDatabase();
  await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** The member row the seed makes, used as "an existing customer". */
async function seedMember(phone: string): Promise<string> {
  const row = await prisma.users.create({
    data: { phone, password_hash: 'x', full_name: 'ลูกค้า เดิม', role: 'member' },
  });
  return row.id;
}

describe('binding by first sign-in (OTP path)', () => {
  it('binds a verified subject to an existing customer, and records consent', async () => {
    const customerId = await seedMember(PHONE);
    const code = await issueOtpChallenge(PHONE);

    const bound = await bindLineToCustomer({
      subject: SUBJECT,
      displayName: 'ลูกค้า ไลน์',
      email: 'line@example.com',
      phone: PHONE,
      code,
      noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
    });

    expect(bound.created).toBe(false);
    expect(bound.id).toBe(customerId);

    const row = await prisma.users.findUnique({ where: { phone: PHONE } });
    expect(row?.line_subject).toBe(SUBJECT);
    expect(row?.line_consent_at).not.toBeNull();
    expect(row?.line_consent_version).not.toBeNull();
    // The email a LINE profile carries is never written over what earlier doors set.
    expect(row?.email).toBeNull();

    const trail = await prisma.audit_logs.findFirst({ where: { action: 'line_bound' } });
    expect(trail).not.toBeNull();
  });

  it('creates a customer when the number is nobody`s — with a password nobody knows', async () => {
    const code = await issueOtpChallenge(PHONE);

    const bound = await bindLineToCustomer({
      subject: SUBJECT,
      displayName: 'ลูกค้า ไลน์',
      email: 'line@example.com',
      phone: PHONE,
      code,
      noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
    });

    expect(bound.created).toBe(true);

    const row = await prisma.users.findUniqueOrThrow({ where: { phone: PHONE } });
    expect(row.role).toBe('member');
    // A random hash, not a null: the password door is closed until they set one.
    expect(row.password_hash).not.toBe('x');
    expect(row.password_hash.length).toBeGreaterThan(20);

    const ack = await prisma.notice_acknowledgements.findFirst({
      where: { customer_user_id: row.id },
    });
    expect(ack).not.toBeNull();
  });

  it('consumes the code — a second binding on the same code is refused', async () => {
    await seedMember(PHONE);
    const code = await issueOtpChallenge(PHONE);

    await bindLineToCustomer({
      subject: SUBJECT,
      displayName: null,
      email: null,
      phone: PHONE,
      code,
      noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
    });

    await expect(
      bindLineToCustomer({
        subject: 'Uline-customer-2',
        displayName: null,
        email: null,
        phone: PHONE,
        code,
        noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
      }),
    ).rejects.toThrow();
  });

  it('refuses a staff number outright', async () => {
    // The seed's admin holds 0800000001; no OTP proof may turn it into a customer.
    const adminPhone = '0800000001';
    const code = await issueOtpChallenge(adminPhone);

    await expect(
      bindLineToCustomer({
        subject: SUBJECT,
        displayName: null,
        email: null,
        phone: adminPhone,
        code,
        noticeVersion: CURRENT_CUSTOMER_NOTICE_VERSION,
      }),
    ).rejects.toThrow();
  });

  it('refuses a new customer without the privacy notice', async () => {
    const code = await issueOtpChallenge(PHONE);

    await expect(
      bindLineToCustomer({
        subject: SUBJECT,
        displayName: null,
        email: null,
        phone: PHONE,
        code,
        noticeVersion: '2000-01-01',
      }),
    ).rejects.toThrow();
  });
});

describe('binding on a session (account path)', () => {
  it('binds without an OTP — the session is the proof', async () => {
    const customerId = await seedMember(PHONE);

    await bindSignedInCustomer({ userId: customerId, subject: SUBJECT });

    const row = await prisma.users.findUniqueOrThrow({ where: { id: customerId } });
    expect(row.line_subject).toBe(SUBJECT);
    expect(row.line_consent_at).not.toBeNull();
  });

  it('refuses a subject another customer already holds', async () => {
    const first = await seedMember('0865550002');
    const second = await seedMember(PHONE);
    await bindSignedInCustomer({ userId: first, subject: SUBJECT });

    await expect(bindSignedInCustomer({ userId: second, subject: SUBJECT })).rejects.toThrow();
  });

  it('refuses a staff row', async () => {
    const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin' } });

    await expect(bindSignedInCustomer({ userId: admin.id, subject: SUBJECT })).rejects.toThrow();
  });

  it('is a no-op when the same account is linked again', async () => {
    const customerId = await seedMember(PHONE);
    await bindSignedInCustomer({ userId: customerId, subject: SUBJECT });

    await expect(bindSignedInCustomer({ userId: customerId, subject: SUBJECT })).resolves.toBeUndefined();
  });
});

describe('unbinding', () => {
  it('clears the subject and the consent together', async () => {
    const customerId = await seedMember(PHONE);
    await bindSignedInCustomer({ userId: customerId, subject: SUBJECT });

    await unbindLineFromCustomer(customerId);

    const row = await prisma.users.findUniqueOrThrow({ where: { id: customerId } });
    expect(row.line_subject).toBeNull();
    expect(row.line_consent_at).toBeNull();
    expect(row.line_consent_version).toBeNull();

    const trail = await prisma.audit_logs.findFirst({ where: { action: 'line_unbound' } });
    expect(trail).not.toBeNull();
  });

  it('is a no-op for a row that never bound', async () => {
    const customerId = await seedMember(PHONE);
    await expect(unbindLineFromCustomer(customerId)).resolves.toBeUndefined();
  });
});

describe('consent on a bound account', () => {
  it('records a fresh yes with the current version', async () => {
    const customerId = await seedMember(PHONE);
    await bindSignedInCustomer({ userId: customerId, subject: SUBJECT });
    await unbindLineFromCustomer;
    await prisma.users.update({ where: { id: customerId }, data: { line_consent_at: null } });

    const result = await setLineNotificationConsent({ userId: customerId, consentVersion: 'v' });

    expect(result.consented).toBe(true);
    const row = await prisma.users.findUniqueOrThrow({ where: { id: customerId } });
    expect(row.line_consent_at).not.toBeNull();
    expect(row.line_consent_version).toBe('v');
  });

  it('refuses consent without a binding — consent without an address is dead weight', async () => {
    const customerId = await seedMember(PHONE);

    await expect(setLineNotificationConsent({ userId: customerId, consentVersion: 'v' })).rejects.toThrow();
  });
});

describe('one LINE account, one customer', () => {
  it('is the unique index that answers when two rows race for one subject', async () => {
    await seedMember('0865550002');
    await bindSignedInCustomer({ userId: await seedMember(PHONE), subject: SUBJECT });

    // A second row claiming the same subject is refused by the database, whatever
    // the reads said a moment earlier.
    await expect(
      prisma.users.create({
        data: {
          phone: '0865550003',
          password_hash: 'x',
          full_name: 'คนที่สาม',
          role: 'member',
          line_subject: SUBJECT,
        },
      }),
    ).rejects.toThrow();
  });

  it('lets any number of customers share the "no LINE" state', async () => {
    await prisma.users.create({ data: { phone: '0865550004', password_hash: 'x', full_name: 'A' } });
    await prisma.users.create({ data: { phone: '0865550005', password_hash: 'x', full_name: 'B' } });

    expect(await prisma.users.count({ where: { line_subject: null } })).toBeGreaterThanOrEqual(2);
  });

  it('round-trips the binding view the account page reads', async () => {
    const customerId = await seedMember(PHONE);
    expect(await lineBindingForUser(customerId)).toEqual({
      lineSubject: null,
      consentAt: null,
      consentVersion: null,
    });

    await bindSignedInCustomer({ userId: customerId, subject: SUBJECT });
    const view = await lineBindingForUser(customerId);
    expect(view?.lineSubject).toBe(SUBJECT);
    expect(view?.consentAt).not.toBeNull();

    // The subject resolves back to the same row the session would name.
    const customer = await findCustomerByLineSubject(SUBJECT);
    expect(customer?.id).toBe(customerId);
  });
});
