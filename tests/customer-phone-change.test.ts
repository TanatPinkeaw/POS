// Seam under test: a customer moves their number, proving the new one (ADR 0020 §5).
//
// A phone is the identity here — points, order history and the collection code hang off
// it — so the failure this suite exists to prevent is a number moving without proof, or
// moving onto one somebody else already owns. Everything below is about *the new number*
// being the one proved, and the row being left exactly as it was on any refusal.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ConflictError, ValidationError } from '@/lib/errors';
import { changeCustomerPhone } from '@/lib/identity';
import { issueOtpChallenge } from '@/lib/otp-store';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

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

/** The trail rows for one target, newest first, for the audit assertions. */
async function auditRowsFor(targetId: string) {
  return prisma.audit_logs.findMany({
    where: { action: 'member_updated', target_id: targetId },
    orderBy: { id: 'asc' },
  });
}

describe('changing a customer phone', () => {
  it('takes effect with the code sent to the new number, and is audited', async () => {
    const newPhone = '0892220001';
    const code = await issueOtpChallenge(newPhone);

    const changed = await changeCustomerPhone({ userId: memberId, newPhone, code });

    expect(changed.id).toBe(memberId);
    expect(changed.phone).toBe(newPhone);
    const row = await prisma.users.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.phone).toBe(newPhone);

    const rows = await auditRowsFor(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ fields: ['phone'], previousPhone: memberPhone });
  });

  it('normalises the new number, so a dashed form finds the challenge that was sent', async () => {
    const code = await issueOtpChallenge('0892220002');

    const changed = await changeCustomerPhone({ userId: memberId, newPhone: '089-222-0002', code });

    expect(changed.phone).toBe('0892220002');
  });

  it('is refused without a code, and leaves the number alone', async () => {
    const failure = (await changeCustomerPhone({
      userId: memberId,
      newPhone: '0892220003',
      code: '123456',
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
    expect(failure.message).toBe('รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว');
    const row = await prisma.users.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.phone).toBe(memberPhone);
    expect(await auditRowsFor(memberId)).toHaveLength(0);
  });

  it('is refused with a wrong code, and leaves the number alone', async () => {
    const code = await issueOtpChallenge('0892220004');

    const failure = (await changeCustomerPhone({
      userId: memberId,
      newPhone: '0892220004',
      code: notThis(code),
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
    const row = await prisma.users.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.phone).toBe(memberPhone);
  });

  it('a code for the old number cannot move the identity to a new one', async () => {
    // The challenge is keyed by the number being moved *to*, and issued for the old
    // one — so this is a code the customer really did receive, just for the wrong door.
    const oldNumberCode = await issueOtpChallenge(memberPhone);

    const failure = (await changeCustomerPhone({
      userId: memberId,
      newPhone: '0892220005',
      code: oldNumberCode,
    }).catch((error: unknown) => error)) as ValidationError;

    expect(failure.code).toBe('VALIDATION_ERROR');
    const row = await prisma.users.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.phone).toBe(memberPhone);
  });
});

describe('a number somebody already owns', () => {
  it('is refused when another customer holds it', async () => {
    const other = await prisma.users.create({
      data: {
        phone: '0892220006',
        password_hash: 'x',
        full_name: 'ลูกค้าคนอื่น',
        role: 'member',
      },
    });
    const code = await issueOtpChallenge('0892220006');

    const failure = (await changeCustomerPhone({
      userId: memberId,
      newPhone: '0892220006',
      code,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('DUPLICATE_ACCOUNT');
    expect(await prisma.users.findUniqueOrThrow({ where: { id: memberId } })).toMatchObject({
      phone: memberPhone,
    });
    expect(await prisma.users.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({
      phone: '0892220006',
    });
  });

  it('is refused when a staff account holds it', async () => {
    const code = await issueOtpChallenge(staffPhone);

    const failure = (await changeCustomerPhone({
      userId: memberId,
      newPhone: staffPhone,
      code,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('DUPLICATE_ACCOUNT');
    const row = await prisma.users.findUniqueOrThrow({ where: { id: memberId } });
    expect(row.phone).toBe(memberPhone);
  });

  it('leaves no audit row behind when the refusal is for a taken number', async () => {
    const code = await issueOtpChallenge(staffPhone);
    await changeCustomerPhone({ userId: memberId, newPhone: staffPhone, code }).catch(() => undefined);

    expect(await auditRowsFor(memberId)).toHaveLength(0);
  });
});

describe('the rule only moves a customer', () => {
  it('refuses to move a staff account through it', async () => {
    const staff = await prisma.users.findUniqueOrThrow({ where: { phone: staffPhone } });
    const code = await issueOtpChallenge('0892220007');

    const failure = (await changeCustomerPhone({
      userId: staff.id,
      newPhone: '0892220007',
      code,
    }).catch((error: unknown) => error)) as ConflictError;

    expect(failure.code).toBe('NOT_A_MEMBER_ACCOUNT');
    expect((await prisma.users.findUniqueOrThrow({ where: { id: staff.id } })).phone).toBe(staffPhone);
  });

  it('refuses a phone that is already the customer’s own, without spending a code', async () => {
    const changed = await changeCustomerPhone({
      userId: memberId,
      newPhone: memberPhone,
      code: '000000',
    });

    expect(changed.phone).toBe(memberPhone);
    expect(await auditRowsFor(memberId)).toHaveLength(0);
  });
});
