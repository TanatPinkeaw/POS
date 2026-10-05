// Seam under test: one product written on its own, and the barcode rule that guards it.
//
// A barcode belongs to at most one product, and the two ways that promise is kept
// fail very differently. The pre-check fails politely: it names the product that
// already holds the code. The unique index fails impolitely: Prisma raises `P2002`,
// and a route that lets it through answers 500 "เกิดข้อผิดพลาดบางอย่าง กรุณาลองใหม่อีกครั้ง" —
// which is how a shop that mistyped a barcode ends up looking for a bug in the
// software instead of at the label in their hand.
//
// So the case worth pinning is the race, and it is reproducible without threads: the
// check and the write are two statements, so a `write` callback that creates the
// clashing row itself lands exactly where the other admin's save would have. The
// suite also pins what a write *accepts*, because the counter in the product form is
// only advice unless the schema enforces the same number.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { ValidationError } from '@/lib/errors';
import { writeProductWithBarcode } from '@/lib/product-writes';
import { productCreateSchema, productUpdateSchema } from '@/lib/schemas';

import { prisma, resetDatabase, seedPeople } from './helpers/test-db';

beforeEach(async () => {
  await resetDatabase();
  await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('writing one product', () => {
  it('creates the row through the rule', async () => {
    const created = await writeProductWithBarcode('885100', () =>
      prisma.products.create({ data: { name: 'กาแฟคั่วบด', barcode: '885100' } }),
    );

    expect(created.name).toBe('กาแฟคั่วบด');
    expect(await prisma.products.count({ where: { barcode: '885100' } })).toBe(1);
  });

  it('refuses a barcode another product already owns, and names it', async () => {
    await prisma.products.create({ data: { name: 'น้ำเปล่า 600 มล.', barcode: '885200' } });

    const failure = await writeProductWithBarcode('885200', () =>
      prisma.products.create({ data: { name: 'น้ำเปล่าอีกยี่ห้อ', barcode: '885200' } }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as Error).message).toBe('บาร์โค้ด 885200 ถูกใช้กับ "น้ำเปล่า 600 มล." อยู่แล้ว');
    expect(await prisma.products.count({ where: { name: 'น้ำเปล่าอีกยี่ห้อ' } })).toBe(0);
  });

  it('answers the same when the clash lands between the check and the write', async () => {
    /*
     * The case the unique index exists for and the pre-check cannot see: by the time
     * the write runs, the code is held by a row that did not exist when we looked.
     * What is asserted is not only that it failed, but that it failed *usefully* — a
     * raw Prisma error here is the 500 with no explanation on screen.
     */
    const failure = await writeProductWithBarcode('885300', async () => {
      await prisma.products.create({ data: { name: 'ของคนอื่นที่บันทึกก่อน', barcode: '885300' } });
      return prisma.products.create({ data: { name: 'ของเรา', barcode: '885300' } });
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as Error).message).toBe(
      'บาร์โค้ด 885300 ถูกใช้กับ "ของคนอื่นที่บันทึกก่อน" อยู่แล้ว',
    );
    expect(await prisma.products.count({ where: { name: 'ของเรา' } })).toBe(0);
  });

  it('lets a product keep its own barcode, so saving an untouched form is not a clash', async () => {
    const product = await prisma.products.create({ data: { name: 'ชาเขียว', barcode: '885400' } });

    const updated = await writeProductWithBarcode(
      '885400',
      () =>
        prisma.products.update({ where: { id: product.id }, data: { sale_price: 27.5 } }),
      { exceptProductId: product.id },
    );

    expect(Number(updated.sale_price)).toBe(27.5);
  });

  it('recognises the row it is editing however the id was spelled', async () => {
    /*
     * A uuid has no case, and the database agrees: `where: { id }` matches `A` and `a`
     * to the same row, so a caller holding an id out of a URL has no reason to
     * lowercase it. The exclusion has to agree too, or a product saving its own barcode
     * is reported as clashing with itself — which is what the id from a hand-typed
     * capitalised URL did before this comparison stopped being about spelling.
     */
    const product = await prisma.products.create({ data: { name: 'น้าส้ม', barcode: '885600' } });

    const updated = await writeProductWithBarcode(
      '885600',
      () => prisma.products.update({ where: { id: product.id }, data: { sale_price: 12 } }),
      { exceptProductId: product.id.toUpperCase() },
    );

    expect(Number(updated.sale_price)).toBe(12);
  });

  it('still refuses when an edit moves a product onto a barcode that is taken', async () => {
    await prisma.products.create({ data: { name: 'น้ำเปล่า', barcode: '885500' } });
    const mine = await prisma.products.create({ data: { name: 'โซดา', barcode: '885501' } });

    const failure = await writeProductWithBarcode(
      '885500',
      () => prisma.products.update({ where: { id: mine.id }, data: { barcode: '885500' } }),
      { exceptProductId: mine.id },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as Error).message).toBe('บาร์โค้ด 885500 ถูกใช้กับ "น้ำเปล่า" อยู่แล้ว');

    const unchanged = await prisma.products.findUniqueOrThrow({ where: { id: mine.id } });
    expect(unchanged.barcode).toBe('885501');
  });

  it('leaves a write without a barcode alone', async () => {
    const created = await writeProductWithBarcode(undefined, () =>
      prisma.products.create({ data: { name: 'สินค้าที่ไม่มีบาร์โค้ด' } }),
    );

    expect(created.barcode).toBeNull();
  });
});

describe('what a product write accepts', () => {
  it('caps the description at the number the form counts to', () => {
    const required = { name: 'กาแฟ', costPrice: 10, salePrice: 20 };

    expect(productCreateSchema.safeParse({ ...required, description: 'ก'.repeat(1000) }).success).toBe(
      true,
    );
    expect(productCreateSchema.safeParse({ ...required, description: 'ก'.repeat(1001) }).success).toBe(
      false,
    );

    /*
     * The update shape is the create shape made partial, so the ceiling travels with
     * it — which is what makes this one rule rather than a second one to forget.
     */
    expect(productUpdateSchema.safeParse({ description: 'ก'.repeat(1001) }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ description: null }).success).toBe(true);
  });
});
