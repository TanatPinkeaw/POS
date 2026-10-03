// Seam under test: the consignor's own view of their position (ADR 0023, ADR 0020).
//
// Seeing their own money is what keeps a consignment arrangement out of dispute, so
// the properties that matter here are the ones a wrong number would break: the figures
// the member reads are the ledger's own (not a second arithmetic), a payout reads as a
// settled statement and a refund as a reversal, nothing consigned reads as an empty
// state rather than an error, and one member can never read another's position.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { consignorBalance } from '@/lib/consignment-payout';
import { payConsignor } from '@/lib/consignment-payout';
import { setConsignment } from '@/lib/consignment';
import { loadCustomerConsignment } from '@/lib/consignment-portal';
import { refundOrder } from '@/lib/credit-notes';
import { createPosSale } from '@/lib/orders';

import {
  prisma,
  resetDatabase,
  seedOpenShift,
  seedPeople,
  seedProduct,
  seedShop,
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

/** Consigns a product to the seeded member at an agreed share. */
async function consign(productId: string, sharePercent: number): Promise<void> {
  await prisma.$transaction((tx) =>
    setConsignment(tx, {
      productId,
      consignorUserId: people.memberId,
      sharePercent,
      actorId: people.adminId,
    }),
  );
}

/** A VAT-registered shop and an open drawer. */
async function shopAndShift(): Promise<number> {
  await seedShop({ isVatRegistered: true, vatRate: 7 });
  return seedOpenShift(people.employeeId);
}

/** Sells `quantity` of a ฿107 (฿100 net) consigned product. */
async function sell(shiftId: number, productId: string, quantity = 1) {
  return createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId, quantity }],
    customerId: null,
    settlement: { cash: 107 * quantity },
  });
}

describe('the consignor’s own view', () => {
  it('reads the same figures the ledger holds', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ name: 'กาแฟฝากขาย', salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sell(shiftId, product.id, 1);

    const view = await loadCustomerConsignment(people.memberId);

    // The balance is the ledger's own sum, to the satang — not a recomputation.
    expect(view.balanceThb).toBe(40);
    expect(view.balanceThb).toBe(await consignorBalance(prisma, people.memberId));

    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({
      productId: product.id,
      sharePercent: 40,
      onHandQty: 4,
      soldQty: 1,
      refundedQty: 0,
      earnedThb: 40,
    });

    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ kind: 'sale', amountThb: 40, payoutId: null });
  });

  it('shows a payout as a settled statement and a refund as a reversal', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);

    const { orderId } = await sell(shiftId, product.id, 1);
    await refundOrder({
      orderId,
      actorId: people.employeeId,
      reason: 'คืนสินค้า',
      refundMethod: 'cash',
      shiftId,
    });
    await sell(shiftId, product.id, 1);

    await prisma.$transaction((tx) =>
      payConsignor(tx, {
        consignorUserId: people.memberId,
        amountThb: 40,
        method: 'promptpay',
        shiftId: null,
        actorId: people.adminId,
      }),
    );

    const view = await loadCustomerConsignment(people.memberId);

    // Newest first: the payout settled the re-sale; the refund reversed the first.
    expect(view.entries.map((entry) => entry.kind)).toEqual(['payout', 'sale', 'refund', 'sale']);
    expect(view.balanceThb).toBe(0);

    const payout = view.entries[0];
    expect(payout?.amountThb).toBe(-40);
    expect(payout?.payoutId).not.toBeNull();

    const refund = view.entries.find((entry) => entry.kind === 'refund');
    expect(refund?.amountThb).toBe(-40);

    // The net earned on the product is the sales minus the reversal.
    expect(view.items[0]?.earnedThb).toBe(40);
    expect(view.items[0]?.refundedQty).toBe(1);
  });

  it('shows an empty, honest state when nothing has been consigned', async () => {
    const view = await loadCustomerConsignment(people.memberId);

    expect(view).toEqual({ balanceThb: 0, items: [], entries: [] });
  });

  it('cannot read another member’s position', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sell(shiftId, product.id, 1);

    const stranger = await prisma.users.create({
      data: { phone: '0900000009', password_hash: 'x', full_name: 'คนอื่น', role: 'member' },
    });

    const theirs = await loadCustomerConsignment(stranger.id);
    expect(theirs).toEqual({ balanceThb: 0, items: [], entries: [] });

    // And the consignor still sees their own, untouched.
    const mine = await loadCustomerConsignment(people.memberId);
    expect(mine.balanceThb).toBe(40);
    expect(mine.items).toHaveLength(1);
  });
});
