// Seam under test: reading the catalogue.
//
// This suite exists because of a defect that a small demo catalogue hides. The
// products endpoint used to answer `findMany({ take: 200 })` and the till filtered
// that array in the browser, so a shop with 201 products could not sell the 201st —
// it was stocked, imported and visible in the back office, and simply absent from
// the array the till had. A test database with twenty products passes either way,
// which is exactly why the fixture below is deliberately larger than one page.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { listProducts, PRODUCT_PAGE_SIZE } from '@/lib/product-query';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

/** A catalogue bigger than one page, named so the last item sorts last. */
const CATALOGUE_SIZE = 250;

/** The page size these tests walk the catalogue with. */
const PAGE_SIZE = PRODUCT_PAGE_SIZE;

/**
 * Names padded to three digits, so alphabetical order (which is what a shop's
 * catalogue is ordered by) matches numeric order and the "last" product is
 * unambiguous.
 */
function productName(index: number): string {
  return `สินค้าทดสอบ ${String(index).padStart(3, '0')}`;
}

beforeEach(async () => {
  await resetDatabase();
  await seedPeople();

  const category = await prisma.categories.create({ data: { name: 'ของใช้ในบ้าน' } });

  await prisma.products.createMany({
    data: Array.from({ length: CATALOGUE_SIZE }, (_, index) => ({
      name: productName(index + 1),
      barcode: String(885000000000 + index + 1),
      // The last one carries stock and a price the test can recognise, so a test
      // that finds "a" product cannot pass by finding the wrong one.
      sale_price: index === CATALOGUE_SIZE - 1 ? 999 : 25,
      cost_price: 10,
      stock_qty: index === CATALOGUE_SIZE - 1 ? 7 : 3,
      reserved_qty: 0,
      category_id: index % 2 === 0 ? category.id : null,
    })),
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('listing the catalogue', () => {
  it('returns one page and says how many there are in total', async () => {
    const page = await listProducts();

    expect(page.items).toHaveLength(PRODUCT_PAGE_SIZE);
    expect(page.total).toBe(CATALOGUE_SIZE);
    // The gap between these two numbers is the entire defect: before the fix the
    // client got 200 items and no way to know 50 more existed.
    expect(page.total).toBeGreaterThan(page.items.length);
  });

  it('walks the whole catalogue page by page, with no gap and no repeat', async () => {
    const seen = new Set<string>();
    let offset = 0;

    for (;;) {
      const page = await listProducts({ limit: PRODUCT_PAGE_SIZE, offset });
      if (page.items.length === 0) {
        break;
      }
      for (const item of page.items) {
        // A paging bug that repeats a row is the same defect wearing a hat: the
        // product it displaced is unreachable.
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      offset += PAGE_SIZE;
    }

    expect(seen.size).toBe(CATALOGUE_SIZE);
  });

  it('returns a short final page rather than an empty one', async () => {
    const remainder = CATALOGUE_SIZE % PAGE_SIZE;
    const lastPage = await listProducts({
      limit: PAGE_SIZE,
      offset: CATALOGUE_SIZE - remainder,
    });

    expect(lastPage.items).toHaveLength(remainder);
    expect(lastPage.items.at(-1)?.name).toBe(productName(CATALOGUE_SIZE));
  });

  it('finds the last product of the whole catalogue by search', async () => {
    // The scenario from the shop floor: a cashier types the name of the item that
    // happens to sort last, and it has to be sellable.
    const found = await listProducts({ search: productName(CATALOGUE_SIZE) });

    expect(found.total).toBe(1);
    expect(found.items[0]?.name).toBe(productName(CATALOGUE_SIZE));
    expect(found.items[0]?.salePrice).toBe(999);
  });

  it('finds a product by barcode no matter where it sits in the catalogue', async () => {
    const barcode = String(885000000000 + CATALOGUE_SIZE);
    const found = await listProducts({ barcode });

    expect(found.items).toHaveLength(1);
    expect(found.items[0]?.barcode).toBe(barcode);
  });

  it('filters by category and counts only what matched', async () => {
    const category = await prisma.categories.findFirstOrThrow();

    const page = await listProducts({ categoryId: category.id, limit: 500 });

    expect(page.total).toBe(CATALOGUE_SIZE / 2);
    for (const item of page.items) {
      expect(item.categoryId).toBe(category.id);
    }
  });

  it('clamps a caller asking for the whole table at once', async () => {
    // A client may ask for anything; the server decides what a response may weigh.
    const page = await listProducts({ limit: 100_000 });
    expect(page.items.length).toBeLessThanOrEqual(200);
  });

  it('derives availability, so a reserved item is not sold twice', async () => {
    const target = await prisma.products.findFirstOrThrow({
      where: { name: productName(CATALOGUE_SIZE) },
    });
    await prisma.products.update({
      where: { id: target.id },
      data: { reserved_qty: 5 },
    });

    const found = await listProducts({ search: productName(CATALOGUE_SIZE) });
    expect(found.items[0]?.stockQty).toBe(7);
    expect(found.items[0]?.reservedQty).toBe(5);
    expect(found.items[0]?.availableQty).toBe(2);
  });

  /*
   * The offline reserve is read *here* rather than in its own suite, because this is the
   * read the till snapshots from: a column the back office sets but this view drops would be
   * a setting that protects nothing (ADR 0019).
   */
  it('reports no offline reserve by default, so a catalogue nobody edited keeps selling', async () => {
    const page = await listProducts({ limit: 5 });

    expect(page.items).toHaveLength(5);
    for (const item of page.items) {
      expect(item.offlineSafetyQty).toBe(0);
    }
  });

  it('carries the shop offline reserve into the read without touching availability', async () => {
    const target = await prisma.products.findFirstOrThrow({
      where: { name: productName(CATALOGUE_SIZE) },
    });
    await prisma.products.update({
      where: { id: target.id },
      data: { offline_safety_qty: 2 },
    });

    const found = await listProducts({ search: productName(CATALOGUE_SIZE) });

    expect(found.items[0]?.offlineSafetyQty).toBe(2);
    // The reserve is a device rule, not a stock movement: the online figure is unchanged.
    expect(found.items[0]?.availableQty).toBe(7);
  });

  it('refuses a negative reserve at the database, not at a code review', async () => {
    // A negative reserve would make `available − safety` larger than the shelf, which
    // reads as a licence to oversell. The CHECK is what makes that unreachable.
    const target = await prisma.products.findFirstOrThrow();

    await expect(
      prisma.products.update({
        where: { id: target.id },
        data: { offline_safety_qty: -1 },
      }),
    ).rejects.toThrow();
  });

  it('orders by name and then by id, so paging cannot shuffle rows', async () => {
    // Two products with the same name are the case that breaks a single-key sort:
    // PostgreSQL is free to return them in either order per query, which shows up
    // as a row appearing on two pages and another on none.
    await prisma.products.createMany({
      data: [
        { name: 'ของซ้ำ', sale_price: 10, cost_price: 5, stock_qty: 1, reserved_qty: 0 },
        { name: 'ของซ้ำ', sale_price: 20, cost_price: 5, stock_qty: 1, reserved_qty: 0 },
      ],
    });

    const first = await listProducts({ search: 'ของซ้ำ' });
    const second = await listProducts({ search: 'ของซ้ำ' });

    expect(first.items.map((item) => item.id)).toEqual(second.items.map((item) => item.id));
    expect(first.total).toBe(2);
  });
});
