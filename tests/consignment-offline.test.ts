// Seam under test: consignment and the offline till meet at exactly one place, and must not
// overlap (ADR 0023 §8).
//
// The device cannot compute a consignor's share, nor record the debt, so a consigned sale with
// no connection is refused at the till. Two facts have to hold for that refusal to be possible
// and to be enough: the device's own view of a product must say the goods are a consignor's
// (otherwise the till could not tell), and if a bill ever did arrive by the replay path it must
// never reach the payable ledger. This file pins both against a real database.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { bangkokDateString } from '@/lib/bangkok-time';
import { setConsignment } from '@/lib/consignment';
import { openNumberBlock } from '@/lib/number-blocks';
import { syncOfflineBatch, type OfflineBillRequest } from '@/lib/offline-sales';
import { listProducts } from '@/lib/product-query';
import { computeVat } from '@/lib/vat';

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

describe('the till’s view of a consigned product', () => {
  it('marks the consignor’s goods, and leaves the shop’s own unmarked', async () => {
    const owned = await seedProduct({ name: 'ของร้าน', stockQty: 5 });
    const consigned = await seedProduct({ name: 'ของฝากขาย', stockQty: 5 });
    await consign(consigned.id, 40);

    const page = await listProducts({});

    const seenOwned = page.items.find((item) => item.id === owned.id);
    const seenConsigned = page.items.find((item) => item.id === consigned.id);
    expect(seenOwned?.isConsigned).toBe(false);
    expect(seenConsigned?.isConsigned).toBe(true);
  });
});

describe('a consigned bill that arrived by the replay path', () => {
  it('is recorded, and reaches the payable ledger for nobody', async () => {
    await seedShop({ receiptPrefix: 'FR' });
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });
    await consign(product.id, 40);

    const block = await openNumberBlock({
      series: 'receipt',
      size: 50,
      deviceLabel: 'แท็บเล็ตหน้าเคาน์เตอร์',
      userId: people.employeeId,
    });
    const shiftId = await seedOpenShift(people.employeeId);

    const soldAt = new Date();
    const amount = 100;
    const tax = computeVat({
      amountThb: amount,
      ratePercent: 7,
      pricesIncludeVat: true,
      isVatRegistered: true,
    });
    const bill: OfflineBillRequest = {
      clientRef: crypto.randomUUID(),
      sequence: 1,
      soldAt: soldAt.toISOString(),
      soldDay: bangkokDateString(soldAt),
      receivedThb: amount,
      totalThb: amount,
      lines: [{ productId: product.id, quantity: 1, unitPrice: amount }],
      numbers: { receipt: { blockId: block.id, value: 1 } },
      tax: {
        isVatInvoice: tax.isVatInvoice,
        vatRatePercent: tax.isVatInvoice ? tax.ratePercent : null,
        netThb: tax.netThb,
        vatThb: tax.vatThb,
      },
    };

    const result = await syncOfflineBatch({
      cashierId: people.employeeId,
      shiftId,
      bills: [bill],
      reports: [],
    });

    // The device's figures are the record on this path, so the bill is accepted — but it
    // owes no share, because the replay never writes one (the till is what refuses).
    expect(result.bills[0]?.status).toBe('recorded');
    expect(await prisma.orders.count()).toBe(1);
    expect(await prisma.consignor_payables.count()).toBe(0);
  });
});
