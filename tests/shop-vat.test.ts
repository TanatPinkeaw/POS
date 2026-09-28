// Seam under test: shop settings → the tax and receipt facts frozen onto a sale.
//
// Against a real database, because the properties that matter are PostgreSQL's:
// that concurrent sales get consecutive numbers with no gaps, that a rolled-back
// sale does not consume one, and that the CHECK constraint genuinely refuses an
// order whose tax lines do not sum to its total.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { bangkokParts } from '@/lib/bangkok-time';
import { fromDecimal } from '@/lib/money';
import { completeOrder, confirmOrder, createPosSale, markOrderReady, placePreOrder } from '@/lib/orders';

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

/** Receipt numbers carry the Bangkok year, which is what the till shows. */
const YEAR = bangkokParts(new Date()).year;
const receipt = (running: number): string => `RC-${YEAR}-${String(running).padStart(6, '0')}`;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function sell(productId: string, shiftId: number, amount: number) {
  return createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId, quantity: 1 }],
    customerId: null,
    settlement: { cash: amount },
  });
}

describe('receipt numbering', () => {
  it('never repeats a number, and never skips one, under concurrent sales', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);

    // One product each, so the sales contend on the shop's counter rather than
    // on a shared product row.
    const products = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        seedProduct({ name: `สินค้า ${index}`, barcode: `885000${index}`, stockQty: 5, salePrice: 100 }),
      ),
    );

    const sales = await Promise.all(products.map((product) => sell(product.id, shiftId, 100)));
    const numbers = sales.map((sale) => sale.receiptNumber).sort();

    expect(numbers).toEqual(Array.from({ length: 12 }, (_, index) => receipt(index + 1)));
  });

  it('does not consume a number when the sale rolls back', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);

    const empty = await seedProduct({ name: 'ของหมด', barcode: 'X1', stockQty: 0, salePrice: 100 });
    const stocked = await seedProduct({ name: 'ของมี', barcode: 'X2', stockQty: 5, salePrice: 100 });

    // The receipt number is allocated before any stock moves, so a failure here
    // is exactly the case a sequence-based counter would punch a hole with.
    await expect(sell(empty.id, shiftId, 100)).rejects.toThrow();

    const sale = await sell(stocked.id, shiftId, 100);
    expect(sale.receiptNumber).toBe(receipt(1));
  });

  it('keeps numbering on when a shop is not VAT-registered', async () => {
    await seedShop({ isVatRegistered: false });
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const sale = await sell(product.id, shiftId, 100);

    expect(sale.receiptNumber).toBeNull();
    expect(sale.isVatInvoice).toBe(false);
  });
});

describe('the tax recorded on a sale', () => {
  it('stores a breakdown that reconstructs the total exactly', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 140, costPrice: 100, stockQty: 5 });

    const sale = await sell(product.id, shiftId, 140);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: sale.orderId } });

    // 140 ÷ 1.07 → 130.84 net, 9.16 VAT.
    expect(fromDecimal(row.final_amount)).toBe(140);
    expect(fromDecimal(row.net_amount)).toBe(130.84);
    expect(fromDecimal(row.vat_amount)).toBe(9.16);
    expect(fromDecimal(row.net_amount) + fromDecimal(row.vat_amount)).toBe(140);

    expect(row.is_vat_invoice).toBe(true);
    expect(row.vat_rate_used).not.toBeNull();
    expect(fromDecimal(row.vat_rate_used ?? 0)).toBe(7);
    expect(row.receipt_number).toBe(sale.receiptNumber);
  });

  it('returns the breakdown to the till so the printed receipt matches', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });

    const sale = await sell(product.id, shiftId, 107);

    expect(sale.netThb).toBe(100);
    expect(sale.vatThb).toBe(7);
    expect(sale.vatRatePercent).toBe(7);
    expect(sale.subtotalThb).toBe(107);
  });

  it('records no tax for a shop that is not VAT-registered', async () => {
    await seedShop({ isVatRegistered: false });
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 140, stockQty: 5 });

    const sale = await sell(product.id, shiftId, 140);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: sale.orderId } });

    expect(fromDecimal(row.net_amount)).toBe(140);
    expect(fromDecimal(row.vat_amount)).toBe(0);
    expect(row.is_vat_invoice).toBe(false);
    expect(row.vat_rate_used).toBeNull();
  });

  it('still sells on a deployment that has not been set up at all', async () => {
    // No shop row: an unconfigured deployment must keep working exactly as it
    // did before VAT existed, recording no tax rather than refusing the sale.
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 140, stockQty: 5 });

    const sale = await sell(product.id, shiftId, 140);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: sale.orderId } });

    expect(sale.receiptNumber).toBeNull();
    expect(fromDecimal(row.net_amount)).toBe(140);
    expect(fromDecimal(row.vat_amount)).toBe(0);
    expect(row.is_vat_invoice).toBe(false);
  });

  it('the database itself refuses an order whose tax lines do not sum to the total', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 140, stockQty: 5 });
    const sale = await sell(product.id, shiftId, 140);

    await expect(
      prisma.$executeRaw`UPDATE "orders" SET "net_amount" = 1 WHERE "id" = ${sale.orderId}::uuid`,
    ).rejects.toThrow();
  });

  it('refuses to sell when the shop is set to VAT-exclusive pricing', async () => {
    await seedShop();
    // Written straight past the API, which refuses this mode: the guard below is
    // what protects a database edited by hand.
    await prisma.$executeRaw`UPDATE "shops" SET "prices_include_vat" = false WHERE "id" = 1`;

    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    await expect(sell(product.id, shiftId, 100)).rejects.toMatchObject({
      code: 'VAT_MODE_UNSUPPORTED',
    });
  });
});

describe('a pre-order is taxed at handover, not at placement', () => {
  it('carries the base only while pending, then the full breakdown on completion', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 107, costPrice: 80, stockQty: 5 });

    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });

    const pending = await prisma.orders.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(pending.is_vat_invoice).toBe(false);
    expect(pending.receipt_number).toBeNull();
    expect(fromDecimal(pending.net_amount)).toBe(107);
    expect(fromDecimal(pending.vat_amount)).toBe(0);

    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });
    const completed = await completeOrder({
      orderId: placed.orderId,
      employeeId: people.employeeId,
      shiftId,
      settlement: { cash: 107 },
    });

    expect(completed.receiptNumber).toBe(receipt(1));
    expect(completed.netThb).toBe(100);
    expect(completed.vatThb).toBe(7);
    expect(completed.isVatInvoice).toBe(true);

    const row = await prisma.orders.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(fromDecimal(row.net_amount) + fromDecimal(row.vat_amount)).toBe(
      fromDecimal(row.final_amount),
    );
  });
});
