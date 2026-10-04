// Seam under test: turning a renter's spreadsheet into a catalogue.
//
// The behaviour worth pinning is that an import cannot bypass the stock audit
// trail — every imported quantity has to appear in `stock_logs` exactly like a
// delivery or a manual correction, or the one screen a manager uses to explain a
// count would have a hole in it.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { commitProductImport, previewProductImport } from '@/lib/product-import';

import { prisma, resetDatabase, seedPeople, type TestPeople } from './helpers/test-db';

let people: TestPeople;

const HEADER = ['บาร์โค้ด', 'ชื่อสินค้า', 'หมวดหมู่', 'ราคาทุน', 'ราคาขาย', 'จำนวนสต็อก'];

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('importing a new catalogue', () => {
  it('creates the products, the categories and an audited opening balance', async () => {
    const grid = [
      HEADER,
      ['885001', 'กาแฟคั่วบด', 'เครื่องดื่ม', '95', '140', '24'],
      ['885002', 'ชาเขียว', 'เครื่องดื่ม', '16', '25', '60'],
    ];

    const preview = await previewProductImport(grid);
    expect(preview.createCount).toBe(2);
    expect(preview.updateCount).toBe(0);
    expect(preview.rows[0]?.resultingStock).toBe(24);

    const summary = await commitProductImport(grid, people.adminId);
    expect(summary).toMatchObject({ created: 2, updated: 0, stockAddedTotal: 84, skipped: 0 });

    const product = await prisma.products.findFirstOrThrow({
      where: { barcode: '885001' },
      include: { category: true },
    });
    expect(product.name).toBe('กาแฟคั่วบด');
    expect(product.stock_qty).toBe(24);
    expect(product.category?.name).toBe('เครื่องดื่ม');

    // The point of the whole exercise: the stock did not arrive invisibly.
    const log = await prisma.stock_logs.findFirstOrThrow({ where: { product_id: product.id } });
    expect(log.reason).toBe('REASON_IMPORT');
    expect(log.movement_type).toBe('restock');
    expect(log.qty_changed).toBe(24);
    expect(log.balance_after).toBe(24);
    expect(log.changed_by).toBe(people.adminId);
  });

  it('creates one category per distinct name, not one per row', async () => {
    await commitProductImport(
      [
        HEADER,
        ['1', 'กาแฟ', 'เครื่องดื่ม', '', '40', '1'],
        ['2', 'ชา', 'เครื่องดื่ม', '', '30', '1'],
        ['3', 'ขนม', 'ขนมขบเคี้ยว', '', '20', '1'],
      ],
      people.adminId,
    );

    const categories = await prisma.categories.findMany({ orderBy: { name: 'asc' } });
    expect(categories.map((category) => category.name)).toEqual(['ขนมขบเคี้ยว', 'เครื่องดื่ม']);
  });

  it('reuses a category that already exists', async () => {
    const existing = await prisma.categories.create({ data: { name: 'เครื่องดื่ม' } });

    await commitProductImport([HEADER, ['1', 'กาแฟ', 'เครื่องดื่ม', '', '40', '1']], people.adminId);

    const product = await prisma.products.findFirstOrThrow({ where: { barcode: '1' } });
    expect(product.category_id).toBe(existing.id);
    expect(await prisma.categories.count()).toBe(1);
  });
});

describe('importing over an existing catalogue', () => {
  it('updates the product a barcode already belongs to', async () => {
    await prisma.products.create({
      data: { name: 'กาแฟ (ชื่อเก่า)', barcode: '885001', cost_price: 90, sale_price: 130, stock_qty: 5 },
    });

    const preview = await previewProductImport([HEADER, ['885001', 'กาแฟคั่วบด', '', '95', '140', '10']]);
    expect(preview.updateCount).toBe(1);
    expect(preview.rows[0]).toMatchObject({
      action: 'update',
      currentStock: 5,
      resultingStock: 15,
      changesPrice: true,
    });

    const summary = await commitProductImport(
      [HEADER, ['885001', 'กาแฟคั่วบด', '', '95', '140', '10']],
      people.adminId,
    );

    expect(summary).toMatchObject({ created: 0, updated: 1 });
    const product = await prisma.products.findFirstOrThrow({ where: { barcode: '885001' } });
    expect(product.name).toBe('กาแฟคั่วบด');
    expect(product.sale_price.toNumber()).toBe(140);
  });

  it('matches by name when the sheet has no barcodes', async () => {
    await prisma.products.create({
      data: { name: 'กาแฟคั่วบด', barcode: null, cost_price: 90, sale_price: 130, stock_qty: 5 },
    });

    const summary = await commitProductImport(
      [HEADER, ['', 'กาแฟคั่วบด', '', '95', '140', '3']],
      people.adminId,
    );

    expect(summary).toMatchObject({ created: 0, updated: 1 });
    expect(await prisma.products.count()).toBe(1);
  });

  it('adds stock on a second import rather than replacing the count', async () => {
    const grid = [HEADER, ['885001', 'กาแฟ', '', '95', '140', '10']];

    await commitProductImport(grid, people.adminId);
    await commitProductImport(grid, people.adminId);

    const product = await prisma.products.findFirstOrThrow({ where: { barcode: '885001' } });
    // Documented and deliberate: the column is an addition, and both additions
    // are separately recorded, so 20 is explainable from the log.
    expect(product.stock_qty).toBe(20);
    expect(await prisma.stock_logs.count({ where: { product_id: product.id } })).toBe(2);
  });
});

describe('a file with problems', () => {
  it('imports the valid rows and reports the rest', async () => {
    const summary = await commitProductImport(
      [
        HEADER,
        ['1', 'กาแฟ', '', '95', '140', '10'],
        ['2', '', '', '', '50', '5'],
        ['3', 'ชา', '', '', 'ไม่ใช่ตัวเลข', '5'],
        ['4', 'ขนม', '', '', '30', '7'],
      ],
      people.adminId,
    );

    expect(summary).toMatchObject({ created: 2, skipped: 2 });
    expect(await prisma.products.count()).toBe(2);
  });

  it('skips a row whose description is longer than the form would have allowed', async () => {
    const grid = [
      [...HEADER, 'รายละเอียด'],
      ['1', 'กาแฟ', '', '95', '140', '10', 'คั่วกลาง'],
      ['2', 'ชาเขียว', '', '16', '25', '5', 'ก'.repeat(1001)],
    ];

    const preview = await previewProductImport(grid);
    expect(preview.rows[1]?.issues.map((issue) => issue.message)).toContain(
      'รายละเอียดยาวเกิน 1000 ตัวอักษร',
    );

    const summary = await commitProductImport(grid, people.adminId);
    expect(summary).toMatchObject({ created: 1, skipped: 1 });

    const stored = await prisma.products.findFirstOrThrow({ where: { barcode: '1' } });
    expect(stored.description).toBe('คั่วกลาง');
    expect(await prisma.products.count({ where: { barcode: '2' } })).toBe(0);
  });

  it('refuses outright when nothing in the file is usable', async () => {
    await expect(
      commitProductImport([HEADER, ['1', '', '', '', '50', '5']], people.adminId),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await prisma.products.count()).toBe(0);
  });

  it('refuses when a required column is missing entirely', async () => {
    await expect(
      commitProductImport([['บาร์โค้ด', 'ชื่อสินค้า'], ['1', 'กาแฟ']], people.adminId),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('preview reports a file-level problem without judging any row', async () => {
    const preview = await previewProductImport([['บาร์โค้ด'], ['1']]);

    expect(preview.rows).toEqual([]);
    expect(preview.issues.length).toBeGreaterThan(0);
  });
});
