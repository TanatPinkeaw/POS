// Seam under test: a product can belong to a consignor, and the shop keeps a ledger of
// what it owes them (ADR 0023 §2).
//
// The rules here are *database* rules on purpose, not application ones. A product with a
// share but no consignor, a consignor with no share, a share outside 0–100, or a ledger
// row whose sign disagrees with its kind are states that must not exist — and the only
// place that can promise they never do is the database, because every future code path
// would otherwise have to remember to refuse them.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

let memberId: string;
let adminId: string;

beforeEach(async () => {
  await resetDatabase();
  const people = await seedPeople();
  memberId = people.memberId;
  adminId = people.adminId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a consigned product', () => {
  it('round-trips the member who consigned it and the agreed share', async () => {
    const product = await prisma.products.create({
      data: { name: 'กระเป๋าฝากขาย', consignor_user_id: memberId, consignor_share_percent: 60 },
    });

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.consignor_user_id).toBe(memberId);
    expect(row.consignor_share_percent).toBe(60);
  });

  it('is shop-owned by default — both columns null', async () => {
    const product = await prisma.products.create({ data: { name: 'สินค้าของร้าน' } });

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.consignor_user_id).toBeNull();
    expect(row.consignor_share_percent).toBeNull();
  });

  it('refuses a share outside 0–100 in the database, not only in the application', async () => {
    await expect(
      prisma.products.create({
        data: { name: 'เกินร้อย', consignor_user_id: memberId, consignor_share_percent: 150 },
      }),
    ).rejects.toThrow();
  });

  it('refuses the two columns moving apart', async () => {
    // A share with no consignor is terms with no owner; a consignor with no share is a
    // liability with no terms. Neither is a product the shop can price.
    await expect(
      prisma.products.create({ data: { name: 'เปอร์เซ็นต์ลอย', consignor_share_percent: 50 } }),
    ).rejects.toThrow();
    await expect(
      prisma.products.create({ data: { name: 'เจ้าของไม่มีส่วนแบ่ง', consignor_user_id: memberId } }),
    ).rejects.toThrow();
  });
});

describe('the consignor ledger', () => {
  it('sums a credit and a debit to the balance owed', async () => {
    // A payout debit must name the statement it settles (ticket 08): money never leaves
    // the ledger without the paper behind it, so the row is written through a payout.
    const payout = await prisma.consignor_payouts.create({
      data: {
        consignor_user_id: memberId,
        method: 'promptpay',
        amount_thb: 25,
        created_by: adminId,
      },
    });
    await prisma.consignor_payables.create({
      data: { consignor_user_id: memberId, kind: 'sale', amount_thb: 60 },
    });
    await prisma.consignor_payables.create({
      data: {
        consignor_user_id: memberId,
        kind: 'payout',
        amount_thb: -25,
        payout_id: payout.id,
      },
    });

    const rows = await prisma.consignor_payables.findMany({ where: { consignor_user_id: memberId } });
    const balance = rows.reduce((total, row) => total + row.amount_thb.toNumber(), 0);
    expect(balance).toBe(35);
  });

  it('refuses a debit written as a sale, or a credit written as a payout', async () => {
    await expect(
      prisma.consignor_payables.create({
        data: { consignor_user_id: memberId, kind: 'sale', amount_thb: -1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.consignor_payables.create({
        data: { consignor_user_id: memberId, kind: 'payout', amount_thb: 1 },
      }),
    ).rejects.toThrow();
  });
});
