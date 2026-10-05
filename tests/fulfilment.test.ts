// Seam under test: the call board — what may move, and what is on it (ADR 0018).
//
// Two halves again, and for the same reason as the call number's own suite: the
// legality is pure and reasoned about here, while "what is on the board today" is a
// property of the rows — including the two that a test double cannot demonstrate,
// namely that a refunded bill cannot be called and that yesterday's forgotten
// ticket leaves the board when the Bangkok day turns over.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { addBangkokDays, bangkokDateString, dateColumnFromDay } from '@/lib/bangkok-time';
import { collectTicket, listQueueTickets, markTicketReady } from '@/lib/fulfilment';
import { canFulfil, isWaiting, nextFulfilment } from '@/lib/fulfilment-state';
import {
  completeOrder,
  confirmOrder,
  createPosSale,
  markOrderReady,
  placePreOrder,
} from '@/lib/orders';

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

function sell(productId: string, shiftId: number, customerId: string | null = null) {
  return createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId, quantity: 1 }],
    customerId,
    settlement: { cash: 100 },
  });
}

describe('what may move, and from where', () => {
  it('makes a drink ready, and hands it over', () => {
    expect(nextFulfilment('preparing', 'mark_ready')).toBe('ready');
    expect(nextFulfilment('ready', 'collect')).toBe('collected');
    expect(canFulfil('preparing', 'mark_ready')).toBe(true);
    expect(canFulfil('ready', 'mark_ready')).toBe(false);
  });

  it('lets a ticket be handed over without being marked ready first', () => {
    // The busy-afternoon case: the cup is over the counter and nobody tapped the
    // middle button. Refusing this would leave that bill on a customer-facing board
    // for the rest of the day.
    expect(canFulfil('preparing', 'collect')).toBe(true);
    expect(nextFulfilment('preparing', 'collect')).toBe('collected');
  });

  it('treats collected as the end', () => {
    expect(canFulfil('collected', 'mark_ready')).toBe(false);
    expect(canFulfil('collected', 'collect')).toBe(false);
    expect(() => nextFulfilment('collected', 'collect')).toThrow();
  });

  it('counts preparing and ready as still waiting, and collected as not', () => {
    expect(isWaiting('preparing')).toBe(true);
    expect(isWaiting('ready')).toBe(true);
    expect(isWaiting('collected')).toBe(false);
  });
});

describe('the board a walk-in sale lands on', () => {
  it('puts the paid bill on it, preparing, with its call number', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ name: 'กาแฟเย็น', salePrice: 100, stockQty: 5 });

    const sale = await sell(product.id, shiftId);
    const tickets = await listQueueTickets();

    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      orderId: sale.orderId,
      queueNumber: '001',
      state: 'preparing',
      items: ['กาแฟเย็น ×1'],
    });
  });

  it('moves a ticket to ready when the drink is made, and off the board when handed over', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });
    const sale = await sell(product.id, shiftId);

    const became = await markTicketReady(sale.orderId);
    expect(became.state).toBe('ready');

    const board = await listQueueTickets();
    expect(board).toHaveLength(1);
    expect(board[0]?.state).toBe('ready');

    // `ready_at` is the same column a pre-order uses for the same fact, so the two
    // paths agree about when a customer could have collected.
    const stored = await prisma.orders.findUniqueOrThrow({
      where: { id: sale.orderId },
      select: { ready_at: true, status: true },
    });
    expect(stored.ready_at).not.toBeNull();
    expect(stored.status).toBe('completed');

    await collectTicket(sale.orderId);
    expect(await listQueueTickets()).toHaveLength(0);
  });

  it('refuses a second tap on the same ticket', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });
    const sale = await sell(product.id, shiftId);

    await markTicketReady(sale.orderId);

    // Two tablets at one bar: the second tap has to fail loudly rather than quietly
    // draw a board that no longer matches the shop.
    await expect(markTicketReady(sale.orderId)).rejects.toThrow(
      /ทำเครื่องหมายว่าพร้อมรับซ้ำไม่ได้/,
    );
  });

  it('refuses to call a bill whose money went back', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });
    const sale = await sell(product.id, shiftId);

    /*
     * The refund itself is not what is under test here — `partial-refunds.test.ts`
     * and `credit-notes.test.ts` own that path. What is under test is the guard that
     * reads `status`, so the status is set the one way a completed bill reaches
     * `refunded`: by a refund, which is what that column means.
     */
    await prisma.orders.update({ where: { id: sale.orderId }, data: { status: 'refunded' } });

    await expect(markTicketReady(sale.orderId)).rejects.toThrow(
      /มีเฉพาะบิลที่ปิดแล้วเท่านั้น/,
    );
  });

  it('has no ticket for a pre-order, even once it is collected', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });

    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });
    await completeOrder({
      orderId: placed.orderId,
      employeeId: people.employeeId,
      shiftId,
      settlement: { cash: 100 },
    });

    // Paid and completed, and still not a ticket: its handover was the moment it was
    // paid for, so a number to wait for would be one nobody calls (ADR 0017 decision 5).
    expect(await listQueueTickets()).toHaveLength(0);
    await expect(markTicketReady(placed.orderId)).rejects.toThrow(/ไม่มีเลขคิว/);
  });

  it('drops yesterday from the board, however it was left', async () => {
    await seedShop();
    const yesterday = addBangkokDays(bangkokDateString(new Date()), -1);

    await prisma.orders.create({
      data: {
        order_number: 'PO-20260928-000001',
        order_type: 'pos_walkin',
        status: 'completed',
        queue_number: 9,
        queue_day: dateColumnFromDay(yesterday),
        fulfilment: 'preparing',
        completed_at: new Date(),
      },
    });

    // Today's board does not carry it, so a ticket nobody ever tapped cannot sit in
    // front of customers for the rest of the shop's life.
    expect(await listQueueTickets()).toHaveLength(0);
    expect(await listQueueTickets(dateColumnFromDay(yesterday))).toHaveLength(1);
  });
});
