// Seam under test: customer accounts, against a real database.
//
// The thing being defended here is not "an admin can add a customer" — that is
// the easy half. It is that a customer account is a *credential that can reserve
// stock without paying*, so creating one has to leave a trail, that two people
// cannot share a phone number however it is punctuated, and that this surface
// cannot become a back door for changing somebody's role.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { listAuditLogs } from '@/lib/audit';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { createMember, listMembers, updateMember } from '@/lib/members';
import { verifyPassword } from '@/lib/password';

import { prisma, resetDatabase, seedPeople, type TestPeople } from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const INPUT = {
  fullName: 'สมหญิง ลูกค้าใหม่',
  phone: '0900000002',
  password: 'member-pass-1',
};

/** The stored hash for a user, so a password change can be proven rather than assumed. */
async function storedHash(userId: string): Promise<string> {
  const row = await prisma.users.findUniqueOrThrow({ where: { id: userId } });
  return row.password_hash;
}

describe('creating a customer', () => {
  it('creates a member, whatever the caller intended', async () => {
    const created = await createMember(INPUT);

    expect(created).toMatchObject({
      fullName: INPUT.fullName,
      phone: INPUT.phone,
      email: null,
      isActive: true,
      pointsBalance: 0,
      orderCount: 0,
    });

    const row = await prisma.users.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.role).toBe('member');
  });

  it('recognises the same number written with punctuation', async () => {
    await createMember(INPUT);

    // The customer at the next table types it with dashes.
    await expect(createMember({ ...INPUT, phone: '090-000-0002' })).rejects.toThrow(ConflictError);
  });

  it('refuses a phone number that belongs to a staff account', async () => {
    // Not a member yet, but the column is unique across every role, and a cashier
    // whose number is "reused" by a customer would be unable to sign in.
    await expect(
      createMember({ ...INPUT, phone: '0800000002' }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses a password below the one rule the system states once', async () => {
    await expect(createMember({ ...INPUT, password: 'short1' })).rejects.toThrow(ValidationError);
  });

  it('trims a name and keeps an email only when there is one', async () => {
    const created = await createMember({
      ...INPUT,
      fullName: '  สมหญิง ลูกค้าใหม่  ',
      email: '   ',
    });

    expect(created.fullName).toBe('สมหญิง ลูกค้าใหม่');
    expect(created.email).toBeNull();

    const withEmail = await createMember({
      ...INPUT,
      phone: '0900000003',
      email: ' somying@example.com ',
    });
    expect(withEmail.email).toBe('somying@example.com');
  });

  it('writes the creation to the trail, naming who did it', async () => {
    const created = await createMember({ ...INPUT, actorId: people.adminId });

    const trail = await listAuditLogs({ action: 'member_created' });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.actor?.id).toBe(people.adminId);
    expect(trail[0]?.targetId).toBe(created.id);
    expect(trail[0]?.detail).toMatchObject({ phone: INPUT.phone });
  });
});

describe('editing a customer', () => {
  it('renames without pretending something sensitive changed', async () => {
    const created = await createMember(INPUT);

    const updated = await updateMember({ id: created.id, fullName: 'สมหญิง ใจดี' });

    expect(updated.fullName).toBe('สมหญิง ใจดี');
    // A new name is not a new credential; the trail is for what a person needs to
    // be able to find later, not for every keystroke.
    expect(await listAuditLogs({ action: 'member_updated' })).toHaveLength(0);
  });

  it('records the fields that matter, and what the login identifier was', async () => {
    const created = await createMember(INPUT);

    await updateMember({
      id: created.id,
      actorId: people.adminId,
      phone: '090-000-0099',
      isActive: false,
    });

    const trail = await listAuditLogs({ action: 'member_updated' });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.detail).toMatchObject({
      fields: ['phone', 'active'],
      previousPhone: INPUT.phone,
    });
  });

  it('resets a password, and proves the old one stops working', async () => {
    const created = await createMember(INPUT);
    const before = await storedHash(created.id);

    await updateMember({ id: created.id, password: 'member-pass-2' });

    const after = await storedHash(created.id);
    expect(after).not.toBe(before);
    expect(await verifyPassword('member-pass-2', after)).toBe(true);
    expect(await verifyPassword(INPUT.password, after)).toBe(false);
  });

  it('refuses a password below the rule even when everything else is fine', async () => {
    const created = await createMember(INPUT);

    await expect(updateMember({ id: created.id, password: 'short1' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('refuses to take a phone number another account already owns', async () => {
    const created = await createMember(INPUT);

    await expect(
      updateMember({ id: created.id, phone: '0900000001' }),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses an account that is not there', async () => {
    await expect(
      updateMember({ id: '00000000-0000-0000-0000-000000000000', fullName: 'ไม่มีคนนี้' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses to edit somebody else`s account through this screen', async () => {
    // The inverse of what `updateStaff` refuses. Without this, the customer screen
    // would be a way to change a cashier's name, phone number or password.
    await expect(
      updateMember({ id: people.employeeId, fullName: 'ไม่ใช่ลูกค้า' }),
    ).rejects.toThrow(ConflictError);
  });

  it('leaves the account alone when nothing is sent', async () => {
    const created = await createMember(INPUT);

    const unchanged = await updateMember({ id: created.id });

    expect(unchanged).toMatchObject({ fullName: INPUT.fullName, phone: INPUT.phone });
    expect(await listAuditLogs({ action: 'member_updated' })).toHaveLength(0);
  });
});

describe('listing customers', () => {
  it('returns the shop`s customers and nobody else', async () => {
    await createMember({ ...INPUT, fullName: 'ข ลูกค้า' });
    await createMember({ ...INPUT, fullName: 'ก ลูกค้า', phone: '0900000004' });

    const members = await listMembers();

    // The seeded member plus the two just created — and never the admin or the
    // cashier, however useful a combined list might look.
    expect(members).toHaveLength(3);
    expect(members.map((member) => member.fullName)).toEqual([
      'ก ลูกค้า',
      'ข ลูกค้า',
      'ลูกค้า',
    ]);
  });

  it('carries the points balance and how many orders the account has', async () => {
    const created = await createMember(INPUT);

    const [seeded] = (await listMembers()).filter((member) => member.id === people.memberId);
    expect(seeded).toBeDefined();

    const [fresh] = (await listMembers()).filter((member) => member.id === created.id);
    expect(fresh?.pointsBalance).toBe(0);
    expect(fresh?.orderCount).toBe(0);
  });
});
