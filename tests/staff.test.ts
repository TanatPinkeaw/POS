// Seam under test: staff accounts and the lock-out guards around them.
//
// The invariant with teeth is "a shop can never remove its last way in": without
// it a manager can deactivate every administrator and there is no support desk to
// call. Two of the tests below are about *concurrency* on that invariant, which
// is why they run against a real database and use the advisory lock the
// implementation takes.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { checkIn } from '@/lib/attendance';
import { createStaff, listStaff, updateStaff } from '@/lib/staff';
import { verifyPassword } from '@/lib/password';

import {
  prisma,
  resetDatabase,
  seedOpenShift,
  seedPeople,
  type TestPeople,
} from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const NEW_ACCOUNT = {
  fullName: 'สมหญิง พนักงานใหม่',
  phone: '0800000009',
  role: 'employee' as const,
  password: 'secret123',
};

describe('creating an account', () => {
  it('stores a usable password hash rather than the password', async () => {
    const created = await createStaff(NEW_ACCOUNT);
    const row = await prisma.users.findUniqueOrThrow({ where: { id: created.id } });

    expect(row.password_hash).not.toContain('secret123');
    expect(await verifyPassword('secret123', row.password_hash)).toBe(true);
    expect(await verifyPassword('secret124', row.password_hash)).toBe(false);
  });

  it('refuses a password below the minimum length', async () => {
    await expect(createStaff({ ...NEW_ACCOUNT, password: 'short' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('refuses a phone number that already has an account', async () => {
    await createStaff(NEW_ACCOUNT);
    await expect(createStaff({ ...NEW_ACCOUNT, fullName: 'อีกคน' })).rejects.toMatchObject({
      code: 'DUPLICATE_ACCOUNT',
    });
  });

  it('treats a punctuated phone number as the same person', async () => {
    // Thai numbers are written 080-000-0009 as often as 0800000009; treating
    // those as two accounts would let one person hold two logins.
    await createStaff(NEW_ACCOUNT);
    await expect(createStaff({ ...NEW_ACCOUNT, phone: '080-000-0009' })).rejects.toMatchObject({
      code: 'DUPLICATE_ACCOUNT',
    });
  });

  it('lists staff but not customers', async () => {
    await createStaff(NEW_ACCOUNT);
    const staff = await listStaff();

    expect(staff.map((member) => member.phone)).toContain('0800000009');
    expect(staff.map((member) => member.role)).not.toContain('member');
  });
});

describe('the last administrator cannot be removed', () => {
  it('refuses to demote the only active admin', async () => {
    await expect(
      updateStaff({ id: people.adminId, actorId: people.employeeId, role: 'employee' }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('refuses to deactivate the only active admin', async () => {
    await expect(
      updateStaff({ id: people.adminId, actorId: people.employeeId, isActive: false }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('allows it once a second administrator exists', async () => {
    const second = await createStaff({ ...NEW_ACCOUNT, role: 'admin' });

    const demoted = await updateStaff({
      id: people.adminId,
      actorId: second.id,
      role: 'employee',
    });

    expect(demoted.role).toBe('employee');
    // And now the *other* admin is the last one.
    await expect(
      updateStaff({ id: second.id, actorId: people.employeeId, isActive: false }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('lets only one of two simultaneous demotions through', async () => {
    const second = await createStaff({ ...NEW_ACCOUNT, role: 'admin' });

    const outcomes = await Promise.allSettled([
      updateStaff({ id: people.adminId, actorId: second.id, role: 'employee' }),
      updateStaff({ id: second.id, actorId: people.adminId, role: 'employee' }),
    ]);

    // Exactly one succeeds: the other must see that no admin would remain.
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(await prisma.users.count({ where: { role: 'admin', is_active: true } })).toBe(1);
  });

  it('refuses to let an administrator demote themselves, even with a spare', async () => {
    await createStaff({ ...NEW_ACCOUNT, role: 'admin' });

    await expect(
      updateStaff({ id: people.adminId, actorId: people.adminId, role: 'employee' }),
    ).rejects.toMatchObject({ code: 'SELF_DEMOTION' });
    await expect(
      updateStaff({ id: people.adminId, actorId: people.adminId, isActive: false }),
    ).rejects.toMatchObject({ code: 'SELF_DEMOTION' });
  });
});

describe('deactivating someone does not strand live state', () => {
  it('refuses while they are still clocked in', async () => {
    await checkIn({ employeeId: people.employeeId });

    await expect(
      updateStaff({ id: people.employeeId, actorId: people.adminId, isActive: false }),
    ).rejects.toMatchObject({ code: 'STAFF_STILL_CLOCKED_IN' });
  });

  it('refuses while they have an open cash drawer', async () => {
    await seedOpenShift(people.employeeId);

    await expect(
      updateStaff({ id: people.employeeId, actorId: people.adminId, isActive: false }),
    ).rejects.toMatchObject({ code: 'STAFF_HAS_OPEN_SHIFT' });
  });

  it('allows it once the timesheet and the drawer are closed', async () => {
    const log = await checkIn({ employeeId: people.employeeId });
    await prisma.time_logs.update({
      where: { id: log.logId },
      data: { check_out: new Date() },
    });

    const deactivated = await updateStaff({
      id: people.employeeId,
      actorId: people.adminId,
      isActive: false,
    });

    expect(deactivated.isActive).toBe(false);
  });
});

describe('editing an account', () => {
  it('resets a password without touching the rest of the record', async () => {
    const updated = await updateStaff({
      id: people.employeeId,
      actorId: people.adminId,
      password: 'brand-new-pass',
    });

    expect(updated.fullName).toBe('แคชเชียร์');
    const row = await prisma.users.findUniqueOrThrow({ where: { id: people.employeeId } });
    expect(await verifyPassword('brand-new-pass', row.password_hash)).toBe(true);
  });

  it('refuses to manage a customer account from the staff surface', async () => {
    await expect(
      updateStaff({ id: people.memberId, actorId: people.adminId, role: 'employee' }),
    ).rejects.toMatchObject({ code: 'NOT_A_STAFF_ACCOUNT' });
  });

  it('reports a missing account rather than failing obscurely', async () => {
    await expect(
      updateStaff({
        id: '00000000-0000-4000-8000-0000000000ff',
        actorId: people.adminId,
        role: 'employee',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
