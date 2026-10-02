// Seam under test: putting a product into consignment, and taking the goods back
// (ADR 0023 §1, §2).
//
// Two things make this more than a column write. First, the consignor must be a
// *member* — the shop cannot owe a share to a staff account or to an id that does not
// exist. Second, a product that has been sold keeps its owner, because the two sale
// sites read the owner at the moment of sale and a product that changed hands later
// would make "who did we owe for that line" a question with two answers. Both are
// asserted here against the real database, and both leave a trail.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { setConsignment, withdrawConsignment } from '@/lib/consignment';
import { ValidationError } from '@/lib/errors';

import { prisma, resetDatabase, seedPeople, seedProduct, type TestPeople } from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Puts one line of this product on a completed order, so it counts as sold. */
async function sellOnce(productId: string): Promise<void> {
  const order = await prisma.orders.create({
    data: {
      order_number: 'RC-0001',
      status: 'completed',
      subtotal_amount: 100,
      net_amount: 100,
      final_amount: 100,
      is_vat_invoice: false,
      completed_at: new Date(),
    },
    select: { id: true },
  });
  await prisma.order_items.create({
    data: {
      order_id: order.id,
      product_id: productId,
      unit_price: 100,
      unit_cost: 60,
      quantity: 1,
      total_price: 100,
    },
  });
}

/** A second member, for the case where a sold product may not change hands. */
async function seedOtherMember(): Promise<string> {
  const other = await prisma.users.create({
    data: {
      phone: '0900000002',
      password_hash: 'x',
      full_name: 'ลูกค้าคนที่สอง',
      role: 'member',
    },
    select: { id: true },
  });
  return other.id;
}

function consign(productId: string, overrides: { consignorUserId: string; sharePercent: number }) {
  return prisma.$transaction((tx) =>
    setConsignment(tx, { productId, actorId: people.adminId, ...overrides }),
  );
}

describe('putting a product into consignment', () => {
  it('stores the member and the share, and records what changed', async () => {
    const product = await seedProduct({ stockQty: 5 });

    const result = await consign(product.id, {
      consignorUserId: people.memberId,
      sharePercent: 40,
    });
    expect(result.consignorUserId).toBe(people.memberId);

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.consignor_user_id).toBe(people.memberId);
    expect(row.consignor_share_percent).toBe(40);

    const audit = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'consignment_set', target_id: product.id },
    });
    expect(audit.actor_user_id).toBe(people.adminId);
    expect(audit.detail).toMatchObject({
      consignorUserId: people.memberId,
      sharePercent: 40,
      previousConsignorUserId: null,
      previousSharePercent: null,
    });
  });

  it('refuses a consignor who is not a member, and writes nothing', async () => {
    const product = await seedProduct({ stockQty: 5 });

    await expect(
      consign(product.id, { consignorUserId: people.employeeId, sharePercent: 40 }),
    ).rejects.toThrow(ValidationError);

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.consignor_user_id).toBeNull();
    expect(await prisma.audit_logs.count({ where: { action: 'consignment_set' } })).toBe(0);
  });

  it('refuses a consignor who does not exist', async () => {
    const product = await seedProduct({ stockQty: 5 });

    await expect(
      consign(product.id, {
        consignorUserId: '00000000-0000-0000-0000-000000000000',
        sharePercent: 40,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('re-agrees the share of the same member, recording the old value', async () => {
    const product = await seedProduct({ stockQty: 5 });
    await consign(product.id, { consignorUserId: people.memberId, sharePercent: 30 });
    await consign(product.id, { consignorUserId: people.memberId, sharePercent: 45 });

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.consignor_share_percent).toBe(45);

    const audit = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'consignment_set', target_id: product.id },
      orderBy: { id: 'desc' },
    });
    expect(audit.detail).toMatchObject({ sharePercent: 45, previousSharePercent: 30 });
  });

  it('refuses to change the owner once the product has been sold', async () => {
    const product = await seedProduct({ stockQty: 5 });
    await consign(product.id, { consignorUserId: people.memberId, sharePercent: 30 });
    await sellOnce(product.id);
    const otherId = await seedOtherMember();

    await expect(
      consign(product.id, { consignorUserId: otherId, sharePercent: 30 }),
    ).rejects.toThrow(ValidationError);

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.consignor_user_id).toBe(people.memberId);
  });

  it('still lets the same member re-agree the share after the product has sold', async () => {
    const product = await seedProduct({ stockQty: 5 });
    await consign(product.id, { consignorUserId: people.memberId, sharePercent: 30 });
    await sellOnce(product.id);

    // The terms are a bargain, not a fact: a product that has sold may still be
    // renegotiated *with the same owner*, and the audit row is where that lives.
    await consign(product.id, { consignorUserId: people.memberId, sharePercent: 35 });

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.consignor_share_percent).toBe(35);
  });
});

describe('withdrawing unsold goods', () => {
  it('removes the stock with a movement, ends the liability, and records it', async () => {
    const product = await seedProduct({ stockQty: 4 });
    await consign(product.id, { consignorUserId: people.memberId, sharePercent: 30 });

    const result = await prisma.$transaction((tx) =>
      withdrawConsignment(tx, { productId: product.id, actorId: people.adminId, note: 'คืนของ' }),
    );
    expect(result.withdrawnQty).toBe(4);
    expect(result.consignorUserId).toBe(people.memberId);

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.stock_qty).toBe(0);
    expect(row.consignor_user_id).toBeNull();
    expect(row.consignor_share_percent).toBeNull();

    // The shelf really changed, so it is an SRS §4.3 movement — not a silent edit.
    const movement = await prisma.stock_logs.findFirstOrThrow({
      where: { product_id: product.id },
    });
    expect(movement.qty_changed).toBe(-4);
    expect(movement.reason).toBe('REASON_CORRECTION');
    expect(movement.changed_by).toBe(people.adminId);

    const audit = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'consignment_withdrawn', target_id: product.id },
    });
    expect(audit.detail).toMatchObject({ consignorUserId: people.memberId, withdrawnQty: 4 });
  });

  it('refuses a product that is not consigned', async () => {
    const product = await seedProduct({ stockQty: 4 });

    await expect(
      prisma.$transaction((tx) =>
        withdrawConsignment(tx, { productId: product.id, actorId: people.adminId }),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses goods that have already been sold — they are the customer’s', async () => {
    const product = await seedProduct({ stockQty: 4 });
    await consign(product.id, { consignorUserId: people.memberId, sharePercent: 30 });
    await sellOnce(product.id);

    await expect(
      prisma.$transaction((tx) =>
        withdrawConsignment(tx, { productId: product.id, actorId: people.adminId }),
      ),
    ).rejects.toThrow(ValidationError);

    const row = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.consignor_user_id).toBe(people.memberId);
    expect(row.stock_qty).toBe(4);
  });
});
