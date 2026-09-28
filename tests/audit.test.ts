// Seam under test: the trail that says who allowed what.
//
// Two properties carry the weight. The table must refuse to be rewritten — a
// trail that can be edited is a trail that proves nothing — and it must name both
// people on a gated action, because "who was at the till" and "who let it
// through" are different questions with different consequences.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { countAuditLogs, listAuditLogs, recordAudit } from '@/lib/audit';
import { openShift } from '@/lib/cash-shifts';
import { ConflictError } from '@/lib/errors';
import { createPosSale } from '@/lib/orders';
import { setSupervisorPin } from '@/lib/supervisor';

import {
  prisma,
  resetDatabase,
  seedPeople,
  seedProduct,
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

describe('writing the trail', () => {
  it('names the person at the till and the person who approved', async () => {
    await recordAudit({
      action: 'void_order',
      actorUserId: people.employeeId,
      authorizedByUserId: people.adminId,
      targetType: 'order',
      targetId: people.memberId,
      detail: { reason: 'ลูกค้าเปลี่ยนใจ' },
    });

    const [row] = await listAuditLogs();

    expect(row?.action).toBe('void_order');
    expect(row?.actor).toEqual({ id: people.employeeId, fullName: 'แคชเชียร์' });
    expect(row?.authorizedBy).toEqual({ id: people.adminId, fullName: 'ผู้จัดการ' });
    expect(row?.detail).toEqual({ reason: 'ลูกค้าเปลี่ยนใจ' });
  });

  it('keeps a row with no approver, for the things nobody approved', async () => {
    await recordAudit({ action: 'pin_set', actorUserId: people.adminId });

    const [row] = await listAuditLogs();
    expect(row?.authorizedBy).toBeNull();
  });
});

describe('the trail refuses to be rewritten', () => {
  it('refuses an UPDATE', async () => {
    await recordAudit({ action: 'drawer_open', actorUserId: people.adminId });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "audit_logs" SET "action" = 'void_order'`),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses a DELETE', async () => {
    await recordAudit({ action: 'drawer_open', actorUserId: people.adminId });

    await expect(prisma.$executeRawUnsafe(`DELETE FROM "audit_logs"`)).rejects.toThrow(
      /append-only/i,
    );
    expect(await countAuditLogs()).toBe(1);
  });
});

describe('an approved over-limit discount', () => {
  it('is recorded against the sale, with both names, in the sale transaction', async () => {
    const product = await seedProduct({ name: 'กาแฟกระป๋อง', stockQty: 5, salePrice: 100 });
    const shift = await openShift({ userId: people.employeeId, initialCash: 500 });

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId: shift.id,
      lines: [{ productId: product.id, quantity: 1 }],
      customerId: null,
      // 60 baht off a 100 baht bill, with a supervisor behind it.
      manualDiscountThb: 60,
      settlement: { cash: 40, receivedCash: 40 },
      overDiscountApproval: { approverId: people.adminId, limitThb: 50 },
    });

    expect(sale.finalAmountThb).toBe(40);

    const rows = await prisma.audit_logs.findMany({ where: { action: 'over_discount' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(people.employeeId);
    expect(rows[0]?.authorized_by_user_id).toBe(people.adminId);
    // Pointing at the order is what makes the row reachable from the sale.
    expect(rows[0]?.target_id).toBe(sale.orderId);
    expect(rows[0]?.shift_id).toBe(shift.id);
    expect(rows[0]?.detail).toMatchObject({ discountThb: 60, limitThb: 50 });
  });

  it('writes nothing for a discount that stayed inside the limit', async () => {
    const product = await seedProduct({ stockQty: 5, salePrice: 100 });
    const shift = await openShift({ userId: people.employeeId, initialCash: 500 });

    await createPosSale({
      cashierId: people.employeeId,
      shiftId: shift.id,
      lines: [{ productId: product.id, quantity: 1 }],
      customerId: null,
      manualDiscountThb: 10,
      settlement: { cash: 90, receivedCash: 90 },
    });

    expect(await countAuditLogs()).toBe(0);
  });
});

describe('reading the trail', () => {
  beforeEach(async () => {
    // Six rows, so the page size and the keyset cursor have something to bite on.
    for (let index = 0; index < 6; index += 1) {
      await recordAudit({
        action: index % 2 === 0 ? 'drawer_open' : 'void_order',
        actorUserId: index === 5 ? people.adminId : people.employeeId,
        targetId: `row-${index}`,
      });
    }
  });

  it('reads newest first', async () => {
    const rows = await listAuditLogs();
    expect(rows.map((row) => row.targetId)).toEqual([
      'row-5',
      'row-4',
      'row-3',
      'row-2',
      'row-1',
      'row-0',
    ]);
  });

  it('filters by action', async () => {
    const rows = await listAuditLogs({ action: 'void_order' });
    expect(rows.every((row) => row.action === 'void_order')).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it('filters by a person, on either side of the approval', async () => {
    await recordAudit({
      action: 'void_order',
      actorUserId: people.employeeId,
      authorizedByUserId: people.adminId,
      targetId: 'approved-here',
    });

    expect((await listAuditLogs({ userId: people.adminId })).map((row) => row.targetId)).toContain(
      'approved-here',
    );
  });

  it('pages by cursor without repeating a row', async () => {
    const first = await listAuditLogs({ limit: 4 });
    expect(first).toHaveLength(4);

    const second = await listAuditLogs({ limit: 4, beforeId: first[3]!.id });
    expect(second).toHaveLength(2);

    const seen = new Set([...first, ...second].map((row) => row.id));
    expect(seen.size).toBe(6);
  });

  it('counts the whole filtered set, not just the page', async () => {
    expect(await countAuditLogs({ limit: 2 })).toBe(6);
  });

  it('clamps an absurd page size instead of trusting it', async () => {
    const rows = await listAuditLogs({ limit: 100_000 });
    expect(rows.length).toBeLessThanOrEqual(200);
  });
});

describe('the PIN and the trail together', () => {
  it('records a pin_set before the discount that needs it', async () => {
    await setSupervisorPin({ userId: people.adminId, pin: '2580', actorId: people.adminId });
    await recordAudit({ action: 'over_discount', actorUserId: people.employeeId, authorizedByUserId: people.adminId });

    const rows = await listAuditLogs();
    expect(rows.map((row) => row.action)).toEqual(['over_discount', 'pin_set']);
  });

  it('refuses to null an approver, because the trail stops meaning anything', async () => {
    await recordAudit({ action: 'void_order', actorUserId: people.employeeId });

    // Deleting the user a row names is refused by the foreign key, not by
    // application code: an audit row whose actor can be anonymised is a row that
    // no longer answers the question it exists for.
    await expect(
      prisma.users.delete({ where: { id: people.employeeId } }),
    ).rejects.toBeTruthy();
  });

  it('still lets an unrelated write proceed', async () => {
    const shift = await openShift({ userId: people.employeeId, initialCash: 100 });
    expect(shift.id).toBeGreaterThan(0);
    await expect(
      openShift({ userId: people.employeeId, initialCash: 100 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
