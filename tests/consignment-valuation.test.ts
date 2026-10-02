// Seam under test: consigned goods are somebody else's, so the dashboard reports them
// outside the shop's own figures (ADR 0023 §7).
//
// The bug this file exists to catch is a reporting one: filing a consignor's stock — or
// the debt that stock has created — under the shop's own "มูลค่าสต็อก" makes an owner
// believe they are worth more than they are. So the properties under test are that the
// owned valuation counts only owned products, that the consigned stock and the shares
// owed are stated separately, and that the shares-owed figure is the ledger's own sum.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dashboardSnapshot } from '@/lib/analytics';
import { setConsignment } from '@/lib/consignment';
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

/** The ledger's own sum, as a magnitude — what `sharesOwedThb` must equal. */
async function ledgerSum(): Promise<number> {
  const rows = await prisma.consignor_payables.findMany();
  const satang = rows.reduce((total, row) => total + Math.round(Number(row.amount_thb) * 100), 0);
  return satang / 100;
}

describe('the dashboard and consigned goods', () => {
  it('keeps a consigned product’s cost out of the owned valuation', async () => {
    const owned = await seedProduct({ name: 'ของร้าน', stockQty: 10, salePrice: 100, costPrice: 50 });
    const consigned = await seedProduct({
      name: 'ของฝากขาย',
      stockQty: 4,
      salePrice: 100,
      costPrice: 60,
    });
    await consign(consigned.id, 40);

    const snapshot = await dashboardSnapshot();

    // The shop spent ฿500 on its own ten units; the consignor's four are not its money.
    expect(snapshot.catalogue.stockValueAtCostThb).toBe(500);
    expect(snapshot.catalogue.ownedProducts).toBe(1);
    expect(snapshot.catalogue.activeProducts).toBe(2);

    // Stated separately, in the consignment block, not added into the figure above.
    expect(snapshot.consignment.productCount).toBe(1);
    expect(snapshot.consignment.units).toBe(4);
    expect(snapshot.consignment.stockValueAtCostThb).toBe(240);
    expect(snapshot.consignment.sharesOwedThb).toBe(0);

    // The owned product is still the owned one.
    expect(owned.id).not.toBe(consigned.id);
  });

  it('reports the shares owed as the ledger’s own sum, live as the balance moves', async () => {
    await seedShop({ isVatRegistered: true, vatRate: 7 });
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 107, stockQty: 10 });
    await consign(product.id, 40);

    // Two units at ฿107 gross → ฿200 net → a ฿80 share.
    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId: product.id, quantity: 2 }],
      customerId: null,
      settlement: { cash: 214 },
    });

    let snapshot = await dashboardSnapshot();
    expect(snapshot.consignment.sharesOwedThb).toBe(80);
    expect(snapshot.consignment.sharesOwedThb).toBe(await ledgerSum());

    // A partial refund claws half the share back, and the figure follows the ledger.
    const item = await prisma.order_items.findFirstOrThrow({
      where: { order_id: sale.orderId },
      select: { id: true },
    });
    await refundOrder({
      orderId: sale.orderId,
      actorId: people.employeeId,
      reason: 'คืนหนึ่งชิ้น',
      refundMethod: 'cash',
      shiftId,
      lines: [{ orderItemId: item.id.toString(), quantity: 1 }],
    });

    snapshot = await dashboardSnapshot();
    expect(snapshot.consignment.sharesOwedThb).toBe(40);
    expect(snapshot.consignment.sharesOwedThb).toBe(await ledgerSum());
  });

  it('counts everything as owned when nothing is consigned', async () => {
    await seedProduct({ stockQty: 3, salePrice: 100, costPrice: 20 });

    const snapshot = await dashboardSnapshot();

    expect(snapshot.catalogue.stockValueAtCostThb).toBe(60);
    expect(snapshot.catalogue.ownedProducts).toBe(1);
    expect(snapshot.consignment).toEqual({
      productCount: 0,
      units: 0,
      stockValueAtCostThb: 0,
      sharesOwedThb: 0,
    });
  });
});
