// Seam under test: a sale that carries the numbers the till printed itself (ADR 0019).
//
// Against real PostgreSQL, because the properties here are the database's: the loan row
// and the bill move in one transaction, a number cannot be spent twice even if two
// requests race, and a refusal leaves no order behind. Of all the money paths in this
// repository this is the one where "the client told us a number" is true, so the judging
// has to be somewhere that a tampered request cannot talk its way past.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { addBangkokDays, bangkokDateString } from '@/lib/bangkok-time';
import { prisma, resetDatabase, seedOpenShift, seedPeople, seedProduct, seedShop, type TestPeople } from './helpers/test-db';
import { ValidationError } from '@/lib/errors';
import {
  claimNumberFromBlock,
  openNumberBlock,
  reportNumberBlock,
  type NumberBlockRecord,
} from '@/lib/number-blocks';
import { createPosSale, type DeviceNumbers } from '@/lib/orders';
import { createOrderSchema } from '@/lib/schemas';
import { allocateReceiptNumber, isSeriesReserved } from '@/lib/shop';

let people: TestPeople;

/*
 * The days are read off the shop's own clock rather than written down, because the sale
 * this suite drives takes *its* instant from `new Date()`. A hardcoded "today" passes on
 * the day it is written and fails at Bangkok midnight — which is exactly what happened:
 * 2026-09-29 was today when these tests were written, so on the 30th a block borrowed for
 * "today" was refused as the wrong day, and the block borrowed for "tomorrow" became
 * today's. `bangkokDateString` is the same function `createPosSale` judges the claim with,
 * so the fixture and the code cannot disagree about which day it is (rule 10).
 */
const TODAY = bangkokDateString(new Date());
const TOMORROW = addBangkokDays(TODAY, 1);
const LABEL = 'แท็บเล็ตหน้าเคาน์เตอร์';

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
  await seedShop({ receiptPrefix: 'FR' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function borrowReceipts(size = 50): Promise<NumberBlockRecord> {
  return openNumberBlock({ series: 'receipt', size, deviceLabel: LABEL, userId: people.employeeId });
}

function borrowCallNumbers(day: string, size = 100): Promise<NumberBlockRecord> {
  return openNumberBlock({
    series: 'queue',
    day,
    size,
    deviceLabel: LABEL,
    userId: people.employeeId,
  });
}

/** One bill, optionally carrying the numbers the till printed. */
function sell(
  productId: string,
  shiftId: number,
  deviceNumbers?: DeviceNumbers,
): ReturnType<typeof createPosSale> {
  return createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId, quantity: 1 }],
    customerId: null,
    settlement: { cash: 100 },
    ...(deviceNumbers ? { deviceNumbers } : {}),
  });
}

/** The shop's two counters, read raw — where the series actually stands. */
async function counters(): Promise<{ receipt: number; queue: number }> {
  const rows = await prisma.$queryRaw<{ receipt: bigint; queue: number }[]>`
    SELECT "receipt_running_number" AS receipt, "queue_running_number" AS queue
      FROM "shops" WHERE "id" = 1
  `;
  const row = rows[0]!;
  return { receipt: Number(row.receipt), queue: row.queue };
}

/** How far a loan has been recorded as used. */
async function lastUsed(blockId: string): Promise<number | null> {
  const row = await prisma.number_blocks.findUniqueOrThrow({
    where: { id: blockId },
    select: { last_used_number: true },
  });
  return row.last_used_number;
}

describe('a sale that carries its own receipt number', () => {
  it('records the number the till printed and advances the loan, not the counter', async () => {
    const block = await borrowReceipts();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const first = await sell(product.id, shiftId, {
      receipt: { blockId: block.id, value: 1 },
    });
    const second = await sell(product.id, shiftId, {
      receipt: { blockId: block.id, value: 2 },
    });

    expect(first.receiptNumber).toMatch(/^FR-\d{4}-000001$/);
    expect(second.receiptNumber).toMatch(/^FR-\d{4}-000002$/);
    expect(await lastUsed(block.id)).toBe(2);
    // The counter stays where the *loan* left it: the unused tail is still the shop's to
    // give back, which is the whole reason a report exists.
    expect((await counters()).receipt).toBe(50);
    expect(await isSeriesReserved(prisma, 'receipt')).toBe(true);
  });

  it('is the only way to sell while the series is frozen, and it works', async () => {
    const block = await borrowReceipts();

    // Nothing may be allocated while the device holds the receipts…
    await expect(allocateReceiptNumber(prisma, new Date())).rejects.toMatchObject({
      code: 'SERIES_RESERVED',
    });

    // …but the device's own number needs no allocation.
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });
    const sale = await sell(product.id, shiftId, {
      receipt: { blockId: block.id, value: 1 },
    });

    expect(sale.receiptNumber).toMatch(/-000001$/);
    expect((await counters()).receipt).toBe(50);
  });

  it('refuses a number at or behind the mark, and writes no bill', async () => {
    const block = await borrowReceipts();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    for (let value = 1; value <= 3; value++) {
      await sell(product.id, shiftId, { receipt: { blockId: block.id, value } });
    }

    await expect(
      sell(product.id, shiftId, { receipt: { blockId: block.id, value: 3 } }),
    ).rejects.toMatchObject({ code: 'DEVICE_NUMBER_ALREADY_USED' });
    await expect(
      sell(product.id, shiftId, { receipt: { blockId: block.id, value: 2 } }),
    ).rejects.toMatchObject({ code: 'DEVICE_NUMBER_ALREADY_USED' });

    // Refused retries do not add another bill or stock movement.
    expect(await prisma.orders.count()).toBe(3);
    expect(await lastUsed(block.id)).toBe(3);
    const stock = await prisma.products.findUniqueOrThrow({
      where: { id: product.id },
      select: { stock_qty: true },
    });
    expect(stock.stock_qty).toBe(2);
  });

  it('refuses a skipped receipt before writing money or stock', async () => {
    const block = await borrowReceipts();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });
    await expect(sell(product.id, shiftId, { receipt: { blockId: block.id, value: 2 } })).rejects.toMatchObject({ code: 'DEVICE_NUMBER_GAP' });
    expect(await prisma.orders.count()).toBe(0);
    expect(await lastUsed(block.id)).toBeNull();
    expect((await prisma.products.findUniqueOrThrow({ where: { id: product.id } })).stock_qty).toBe(5);
  });

  it('refuses a number the block never lent', async () => {
    const block = await borrowReceipts(10);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    await expect(
      sell(product.id, shiftId, { receipt: { blockId: block.id, value: 11 } }),
    ).rejects.toMatchObject({ code: 'DEVICE_NUMBER_OUT_OF_RANGE' });
    expect(await prisma.orders.count()).toBe(0);
  });

  it('refuses a call-number loan offered as a receipt number', async () => {
    const block = await borrowCallNumbers(TODAY);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    await expect(
      sell(product.id, shiftId, { receipt: { blockId: block.id, value: 1 } }),
    ).rejects.toMatchObject({ code: 'DEVICE_NUMBER_WRONG_SERIES' });
  });

  it('refuses a receipt number on a shop that issues no tax invoice', async () => {
    /*
     * Reachable only when the shop's VAT registration was switched off after the till
     * borrowed, which is precisely why it is a refusal with an explanation rather than a
     * silent re-allocation: the number is already on paper, and the series must not
     * acquire the hole that would leave.
     */
    // The shop is a singleton with `CHECK (id = 1)`, so switching its VAT registration off
    // means starting the fixture over rather than editing the row.
    await resetDatabase();
    people = await seedPeople();
    await seedShop({ isVatRegistered: false, receiptPrefix: 'FR' });
    const block = await borrowReceipts();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    await expect(
      sell(product.id, shiftId, { receipt: { blockId: block.id, value: 1 } }),
    ).rejects.toMatchObject({ code: 'DEVICE_RECEIPT_NUMBER_NOT_APPLICABLE' });
  });
});

describe('a sale that carries its own call number', () => {
  it('prints it with the day the loan was borrowed for', async () => {
    const block = await borrowCallNumbers(TODAY);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const sale = await sell(product.id, shiftId, { call: { blockId: block.id, value: 3 } });

    expect(sale.queueNumber).toBe('003');
    const stored = await prisma.orders.findUniqueOrThrow({
      where: { id: sale.orderId },
      select: { queue_number: true, queue_day: true },
    });
    expect(stored.queue_number).toBe(3);
    expect(stored.queue_day?.toISOString()).toBe(`${TODAY}T00:00:00.000Z`);
    expect(await lastUsed(block.id)).toBe(3);
  });

  it('refuses a number from a day the block is not for', async () => {
    /*
     * The failure this prevents is a tablet whose clock has drifted: tomorrow's numbers
     * spent on today's customers, so somebody is called by a number the board is also
     * using for somebody else.
     */
    const tomorrow = await borrowCallNumbers(TOMORROW);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    await expect(
      sell(product.id, shiftId, { call: { blockId: tomorrow.id, value: 1 } }),
    ).rejects.toMatchObject({ code: 'DEVICE_NUMBER_WRONG_DAY' });
  });

  it('sells with no call number at all when the device holds nothing for today', async () => {
    // The asymmetry ADR 0019 decided: a tax invoice with no number cannot be issued, a
    // drink with no number can be handed over. The bill is otherwise ordinary.
    await borrowCallNumbers(TODAY);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const sale = await sell(product.id, shiftId);

    expect(sale.queueNumber).toBeNull();
    expect(sale.receiptNumber).toMatch(/^FR-\d{4}-000001$/);
  });
});

describe('what the loan and the bills add up to', () => {
  it('continues the shop’s series from the last number a device used', async () => {
    const block = await borrowReceipts();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    for (const value of [1, 2, 3]) {
      await sell(product.id, shiftId, { receipt: { blockId: block.id, value } });
    }
    await reportNumberBlock({ id: block.id, lastUsed: 3, userId: people.employeeId });

    // No gap: the till printed 1, 2, 3 and the next bill the shop issues is 4 — not 51,
    // and not 4 with 4..50 lost.
    expect((await counters()).receipt).toBe(3);
    const next = await allocateReceiptNumber(prisma, new Date());
    expect(next?.receiptNumber).toMatch(/-000004$/);
  });

  it('refuses a loan id that is not a loan, without reaching the database', async () => {
    /*
     * The endpoint's own edge: a malformed id is refused as a 422 by the schema rather
     * than cast inside a transaction, where PostgreSQL's complaint would reach the till
     * as a 500 — the trap `AGENTS.md` records about `InvalidPickupTokenError`.
     */
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    expect(
      createOrderSchema.safeParse({
        type: 'pos_walkin',
        shiftId,
        lines: [{ productId: product.id, quantity: 1 }],
        settlement: { cash: 100 },
        deviceNumbers: { receipt: { blockId: 'not-a-loan', value: 1 } },
      }).success,
    ).toBe(false);
  });

  it('a device sale with no numbers at all is the path the acceptance journey uses', async () => {
    // The guarantee that this work changed nothing for a shop that has borrowed nothing:
    // the server still allocates both series itself.
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const sale = await sell(product.id, shiftId);

    expect(sale.receiptNumber).toMatch(/^FR-\d{4}-000001$/);
    expect(sale.queueNumber).toBe('001');
    expect((await counters()).receipt).toBe(1);
    expect(await prisma.orders.count()).toBe(1);
  });

  it('refuses to judge a call number without a day to judge it against', async () => {
    const block = await borrowCallNumbers(TODAY);

    await expect(
      prisma.$transaction((tx) =>
        claimNumberFromBlock(tx, { blockId: block.id, kind: 'queue', value: 1 }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
