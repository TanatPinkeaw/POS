// Seam under test: the call number a customer is called by (ADR 0017).
//
// Two halves, deliberately in one file because they are one rule seen from two
// sides. The pure half is what a number *looks like*; the half against a real
// database is *which day it belongs to* — and that one cannot be reasoned about in
// a test double, because the property that matters is PostgreSQL's: that the day
// comparison and the counter bump are one statement, and that the pair is unique
// where the database can refuse it rather than where the allocation remembers to.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma, resetDatabase, seedOpenShift, seedPeople, seedProduct, seedShop, type TestPeople } from './helpers/test-db';
import { bangkokDateString } from '@/lib/bangkok-time';
import { createPosSale, placePreOrder } from '@/lib/orders';
import { formatQueueNumber, QUEUE_NUMBER_WIDTH } from '@/lib/queue-number';
import { allocateQueueNumber } from '@/lib/shop';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function sell(productId: string, shiftId: number) {
  return createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId, quantity: 1 }],
    customerId: null,
    settlement: { cash: 100 },
  });
}

describe('what a call number looks like', () => {
  it('pads to the width a ticket is printed at', () => {
    expect(QUEUE_NUMBER_WIDTH).toBe(3);
    expect(formatQueueNumber(1)).toBe('001');
    expect(formatQueueNumber(37)).toBe('037');
    expect(formatQueueNumber(100)).toBe('100');
  });

  it('does not wrap when a shop has a very good day', () => {
    // Padding is not truncation: a number that wrapped would be called twice,
    // and the second customer would collect the first customer's order.
    expect(formatQueueNumber(1000)).toBe('1000');
    expect(formatQueueNumber(12345)).toBe('12345');
  });

  it('refuses a value that is not a number a till could have produced', () => {
    expect(() => formatQueueNumber(0)).toThrow();
    expect(() => formatQueueNumber(-1)).toThrow();
    expect(() => formatQueueNumber(1.5)).toThrow();
  });
});

describe('which day a call number belongs to', () => {
  it('counts 1, 2, 3 across one Bangkok day', async () => {
    await seedShop();

    const morning = new Date('2026-09-29T02:00:00Z'); // 09:00 in Bangkok
    const first = await allocateQueueNumber(prisma, morning);
    const second = await allocateQueueNumber(prisma, morning);
    const third = await allocateQueueNumber(prisma, morning);

    expect([first?.value, second?.value, third?.value]).toEqual([1, 2, 3]);
    expect(first?.day.toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });

  it('starts again at 1 when the day turns over, and only then', async () => {
    await seedShop();

    // 23:30 on the 29th and 00:30 on the 30th are half an hour apart and are two
    // different days. A process reading a plain UTC date would call them the same
    // day for the next seven hours, which is exactly when a shop is open.
    const lateEvening = await allocateQueueNumber(prisma, new Date('2026-09-29T16:30:00Z'));
    const justAfterMidnight = await allocateQueueNumber(prisma, new Date('2026-09-29T17:30:00Z'));
    const nextMorning = await allocateQueueNumber(prisma, new Date('2026-09-30T02:00:00Z'));

    expect(lateEvening?.value).toBe(1);
    expect(justAfterMidnight?.value).toBe(1);
    expect(nextMorning?.value).toBe(2);
  });

  it('keeps counting inside one day across a midnight that has not happened yet', async () => {
    await seedShop();

    const morning = await allocateQueueNumber(prisma, new Date('2026-09-29T02:00:00Z'));
    const evening = await allocateQueueNumber(prisma, new Date('2026-09-29T16:30:00Z'));

    expect([morning?.value, evening?.value]).toEqual([1, 2]);
  });
});

describe('a sale and its call number', () => {
  it('gives a walk-in sale the next number and records the day with it', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const first = await sell(product.id, shiftId);
    const second = await sell(product.id, shiftId);

    expect([first.queueNumber, second.queueNumber]).toEqual(['001', '002']);

    const stored = await prisma.orders.findUniqueOrThrow({
      where: { id: second.orderId },
      select: { queue_number: true, queue_day: true, status: true },
    });
    expect(stored.queue_number).toBe(2);
    // The day the customer heard is Bangkok's, not the runner's: a test machine
    // in any timezone must agree with the till about which day a number belongs to.
    expect(stored.queue_day?.toISOString()).toBe(
      `${bangkokDateString(new Date())}T00:00:00.000Z`,
    );
  });

  it('numbers a sale at a shop that issues no tax invoice', async () => {
    // The reason the series exists at all: a shop that is not VAT-registered has
    // no receipt number — `receiptNumber` is null here — and its customers still
    // have to be called by something.
    await seedShop({ isVatRegistered: false });
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const sale = await sell(product.id, shiftId);

    expect(sale.receiptNumber).toBeNull();
    expect(sale.queueNumber).toBe('001');
  });

  it('does not consume a number when the sale rolls back', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const empty = await seedProduct({ name: 'ของหมด', barcode: 'Q1', stockQty: 0, salePrice: 100 });
    const stocked = await seedProduct({ name: 'ของมี', barcode: 'Q2', stockQty: 5, salePrice: 100 });

    await expect(sell(empty.id, shiftId)).rejects.toThrow();

    const sale = await sell(stocked.id, shiftId);
    expect(sale.queueNumber).toBe('001');
  });

  it('gives a pre-order none: its handover is the moment it is paid for', async () => {
    await seedShop();
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });

    const stored = await prisma.orders.findUniqueOrThrow({
      where: { id: placed.orderId },
      select: { queue_number: true, queue_day: true },
    });
    expect(stored.queue_number).toBeNull();
    expect(stored.queue_day).toBeNull();
  });

  it('lets the database refuse two bills sharing one number on one day', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const sale = await sell(product.id, shiftId);
    const stored = await prisma.orders.findUniqueOrThrow({
      where: { id: sale.orderId },
      select: { queue_day: true },
    });

    await expect(
      prisma.orders.create({
        data: {
          order_number: 'PO-20260929-999999',
          order_type: 'pos_walkin',
          status: 'completed',
          queue_number: 1,
          queue_day: stored.queue_day,
        },
      }),
    ).rejects.toThrow();
  });
});
