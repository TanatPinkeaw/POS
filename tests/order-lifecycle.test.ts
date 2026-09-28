// Seam under test: the SRS §3 lifecycle end to end, against a real database.
// Every assertion is about observable state — order status, the two stock
// counters, the ledger — never about internals.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeShift, openShift } from '@/lib/cash-shifts';
import { ConflictError } from '@/lib/errors';
import { loadOrderView } from '@/lib/order-view';
import {
  cancelOrder,
  completeOrder,
  confirmOrder,
  createPosSale,
  expireStalePendingOrders,
  markOrderReady,
  placePreOrder,
} from '@/lib/orders';
import { tenderedAmount } from '@/lib/tender';

import {
  prisma,
  readCounters,
  resetDatabase,
  seedPeople,
  seedProduct,
  type TestPeople,
} from './helpers/test-db';

let people: TestPeople;

// A clean database per test, not per file. These cases open cash drawers and
// settle orders; sharing state would let one case's open drawer break the next
// one's `openShift`, and would let stock counters leak between assertions.
beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Fresh product per test, so counters never leak between cases. */
async function withProduct(stockQty: number, salePrice = 100, costPrice = 60) {
  const product = await seedProduct({
    name: `สินค้า ${Math.random().toString(36).slice(2, 8)}`,
    stockQty,
    salePrice,
    costPrice,
  });
  return product.id;
}

describe('the four phases', () => {
  it('walks pending → confirmed → ready_for_pickup → completed, converting the reservation into a sale', async () => {
    const productId = await withProduct(10, 100);

    // Phase 1: the reservation claims stock without removing it.
    const placed = await placePreOrder({ customerId: people.memberId, lines: [{ productId, quantity: 2 }] });
    expect(placed.status).toBe('pending');
    expect(await readCounters(productId)).toEqual({ stockQty: 10, reservedQty: 2 });

    // Phase 2
    const confirmed = await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.finalAmountThb).toBe(200);

    // Phase 3: a handover PIN and a hold deadline appear.
    const ready = await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });
    expect(ready.pickupPin).toMatch(/^\d{4}$/);
    expect(ready.pickupExpiresAt.getTime()).toBeGreaterThan(Date.now());

    // Phase 4: pay in cash and settle.
    const shiftId = await openShift({ userId: people.employeeId, initialCash: 2000 }).then((s) => s.id);
    const completed = await completeOrder({
      orderId: placed.orderId,
      employeeId: people.employeeId,
      shiftId,
      settlement: { cash: 200, receivedCash: 250 },
    });

    expect(completed.status).toBe('completed');
    expect(completed.changeThb).toBe(50);
    // 200 THB paid → floor(200 / 3) = 66 points.
    expect(completed.pointsEarned).toBe(66);

    // Both counters drop together, so availability is unchanged by settling.
    expect(await readCounters(productId)).toEqual({ stockQty: 8, reservedQty: 0 });

    const ledger = await prisma.point_transactions.findMany({ where: { user_id: people.memberId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.points_change).toBe(66);
    expect(ledger[0]?.balance_after).toBe(66);
  });

  it('refuses to skip a phase', async () => {
    const productId = await withProduct(5);
    const placed = await placePreOrder({ customerId: people.memberId, lines: [{ productId, quantity: 1 }] });

    await expect(
      markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId }),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      completeOrder({
        orderId: placed.orderId,
        employeeId: people.employeeId,
        shiftId: 1,
        settlement: { cash: 100 },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('partial confirmation', () => {
  it('releases only the removed line and recomputes the total', async () => {
    // Two lines, because partial confirmation is about keeping some: removing
    // the last remaining line is a different case, covered below.
    const keptId = await withProduct(10, 50);
    const brokenId = await withProduct(10, 30);

    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [
        { productId: keptId, quantity: 2 },
        { productId: brokenId, quantity: 3 },
      ],
    });
    // 2 × 50 + 3 × 30
    expect(placed.subtotalThb).toBe(190);

    const order = await loadOrderView(placed.orderId);
    const broken = order.items.find((item) => item.productId === brokenId);
    if (!broken) {
      throw new Error('expected the broken line on the order');
    }

    const result = await confirmOrder({
      orderId: placed.orderId,
      employeeId: people.employeeId,
      removeItemIds: [broken.id],
    });

    // The broken product is sellable again straight away...
    expect(await readCounters(brokenId)).toEqual({ stockQty: 10, reservedQty: 0 });
    // ...while the kept line stays reserved for this customer.
    expect(await readCounters(keptId)).toEqual({ stockQty: 10, reservedQty: 2 });

    expect(result.finalAmountThb).toBe(100);
    await expect(
      prisma.order_items.count({ where: { order_id: placed.orderId } }),
    ).resolves.toBe(1);
  });

  it('refuses to confirm an order whose every line was removed', async () => {
    const productId = await withProduct(3, 50);
    const placed = await placePreOrder({ customerId: people.memberId, lines: [{ productId, quantity: 1 }] });
    const order = await loadOrderView(placed.orderId);
    const only = order.items[0];
    if (!only) {
      throw new Error('expected an order item');
    }

    await expect(
      confirmOrder({
        orderId: placed.orderId,
        employeeId: people.employeeId,
        removeItemIds: [only.id],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('cancellation', () => {
  it('restores reserved stock from every live phase', async () => {
    const productId = await withProduct(6);

    // From Phase 1.
    const pending = await placePreOrder({ customerId: people.memberId, lines: [{ productId, quantity: 3 }] });
    await cancelOrder({ orderId: pending.orderId, actorId: people.employeeId, reason: 'ทดสอบ' });
    expect(await readCounters(productId)).toEqual({ stockQty: 6, reservedQty: 0 });

    // From Phase 3.
    const ready = await placePreOrder({ customerId: people.memberId, lines: [{ productId, quantity: 3 }] });
    await confirmOrder({ orderId: ready.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: ready.orderId, employeeId: people.employeeId });
    await cancelOrder({ orderId: ready.orderId, actorId: people.employeeId, reason: 'ลูกค้าไม่มารับ' });
    expect(await readCounters(productId)).toEqual({ stockQty: 6, reservedQty: 0 });

    const cancelled = await loadOrderView(ready.orderId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('ลูกค้าไม่มารับ');
  });

  it('refuses to cancel an order that has already been settled', async () => {
    const productId = await withProduct(2, 30);
    const shiftId = await openShift({ userId: people.employeeId, initialCash: 0 }).then((s) => s.id);

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId, quantity: 1 }],
      customerId: null,
      settlement: { cash: 30, receivedCash: 30 },
    });

    await expect(
      cancelOrder({ orderId: sale.orderId, actorId: people.employeeId, reason: 'too late' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('the Phase 1 timeout guard', () => {
  it('expires an unconfirmed order and frees its stock', async () => {
    const productId = await withProduct(4);
    const placed = await placePreOrder({ customerId: people.memberId, lines: [{ productId, quantity: 2 }] });
    expect(await readCounters(productId)).toEqual({ stockQty: 4, reservedQty: 2 });

    // Back-date the order past the 15-minute deadline.
    await prisma.orders.update({
      where: { id: placed.orderId },
      data: { created_at: new Date(Date.now() - 20 * 60_000) },
    });

    const swept = await expireStalePendingOrders();
    expect(swept.expired).toBe(1);
    expect(swept.orderIds).toContain(placed.orderId);

    expect(await readCounters(productId)).toEqual({ stockQty: 4, reservedQty: 0 });

    const expired = await loadOrderView(placed.orderId);
    expect(expired.status).toBe('cancelled');
    expect(expired.cancelReason).toMatch(/Expired/);
  });

  it('leaves a recently placed order alone', async () => {
    const productId = await withProduct(3);
    const placed = await placePreOrder({ customerId: people.memberId, lines: [{ productId, quantity: 1 }] });

    const swept = await expireStalePendingOrders();
    expect(swept.orderIds).not.toContain(placed.orderId);
    expect((await loadOrderView(placed.orderId)).status).toBe('pending');
  });

  it('leaves a confirmed order alone however old it is', async () => {
    const productId = await withProduct(3);
    const placed = await placePreOrder({ customerId: people.memberId, lines: [{ productId, quantity: 1 }] });
    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });

    await prisma.orders.update({
      where: { id: placed.orderId },
      data: { created_at: new Date(Date.now() - 60 * 60_000) },
    });

    const swept = await expireStalePendingOrders();
    expect(swept.orderIds).not.toContain(placed.orderId);
    expect((await loadOrderView(placed.orderId)).status).toBe('confirmed');
  });
});

describe('cash drawer settlement — SRS §6.2', () => {
  it('reports a shortage of exactly what is missing', async () => {
    const productId = await withProduct(5, 155);
    const shift = await openShift({ userId: people.employeeId, initialCash: 2000 });

    await createPosSale({
      cashierId: people.employeeId,
      shiftId: shift.id,
      lines: [{ productId, quantity: 1 }],
      customerId: null,
      settlement: { cash: 155, receivedCash: 200 },
    });

    const settled = await closeShift({
      shiftId: shift.id,
      userId: people.employeeId,
      actualCash: 2150,
    });

    expect(settled.expectedCashThb).toBe(2155);
    // discrepancy = actual − (initial + cash sales) = 2150 − 2155
    expect(settled.discrepancyThb).toBe(-5);
    expect(settled.discrepancyKind).toBe('shortage');
  });

  it('ignores PromptPay when reconciling the drawer', async () => {
    const productId = await withProduct(5, 100);
    const shift = await openShift({ userId: people.employeeId, initialCash: 500 });

    await createPosSale({
      cashierId: people.employeeId,
      shiftId: shift.id,
      lines: [{ productId, quantity: 1 }],
      customerId: null,
      settlement: { promptpay: 100 },
    });

    const settled = await closeShift({
      shiftId: shift.id,
      userId: people.employeeId,
      actualCash: 500,
    });

    // No cash changed hands, so the drawer should still hold the float exactly.
    expect(settled.cashSalesThb).toBe(0);
    expect(settled.expectedCashThb).toBe(500);
    expect(settled.discrepancyThb).toBe(0);
    expect(settled.discrepancyKind).toBe('balanced');
  });

  it('refuses to close the same drawer twice', async () => {
    const shift = await openShift({ userId: people.employeeId, initialCash: 100 });
    await closeShift({ shiftId: shift.id, userId: people.employeeId, actualCash: 100 });

    await expect(
      closeShift({ shiftId: shift.id, userId: people.employeeId, actualCash: 100 }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('loyalty on a walk-in sale', () => {
  it('awards points on the net paid amount and deducts redeemed points', async () => {
    const productId = await withProduct(5, 100);
    await prisma.users.update({
      where: { id: people.memberId },
      data: { points_balance: 500 },
    });

    const shiftId = await openShift({ userId: people.employeeId, initialCash: 0 }).then((s) => s.id);

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId, quantity: 1 }],
      customerId: people.memberId,
      // 200 points = 2 THB off, so 98 THB is paid in cash.
      settlement: { points: 200, cash: 98, receivedCash: 100 },
    });

    // 98 / 3 rounded down.
    expect(sale.pointsEarned).toBe(32);
    expect(sale.pointsRedeemed).toBe(200);
    expect(sale.changeThb).toBe(2);

    const member = await prisma.users.findUniqueOrThrow({ where: { id: people.memberId } });
    expect(member.points_balance).toBe(500 - 200 + 32);

    const ledger = await prisma.point_transactions.findMany({
      where: { order_id: sale.orderId },
      orderBy: { id: 'asc' },
    });
    expect(ledger.map((row) => row.points_change)).toEqual([-200, 32]);
    expect(ledger.map((row) => row.balance_after)).toEqual([300, 332]);
  });
});

describe('the tender lines a receipt is printed from', () => {
  it('prints the notes handed over, so the tender and the change subtract to the bill', async () => {
    const productId = await withProduct(1, 35);
    const shift = await openShift({ userId: people.employeeId, initialCash: 2000 });

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId: shift.id,
      lines: [{ productId, quantity: 1 }],
      customerId: null,
      settlement: { cash: 35, receivedCash: 100 },
    });

    expect(sale.finalAmountThb).toBe(35);
    expect(sale.tenders).toEqual([{ method: 'cash', amountThb: 35, receivedThb: 100 }]);
    expect(sale.changeThb).toBe(65);

    // The document's own arithmetic: 100 received − 65 change = the 35 bill.
    expect(tenderedAmount(sale.tenders[0]) - sale.changeThb).toBe(sale.finalAmountThb);
  });

  it('names a transfer as a transfer rather than as cash nobody handled', async () => {
    const productId = await withProduct(1, 100);
    const shift = await openShift({ userId: people.employeeId, initialCash: 500 });

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId: shift.id,
      lines: [{ productId, quantity: 1 }],
      customerId: null,
      settlement: { promptpay: 100 },
    });

    expect(sale.tenders).toEqual([{ method: 'promptpay', amountThb: 100, receivedThb: null }]);
    expect(sale.changeThb).toBe(0);
  });

  it('never prints redeemed points as money', async () => {
    const productId = await withProduct(1, 100);
    await prisma.users.update({
      where: { id: people.memberId },
      data: { points_balance: 200 },
    });
    const shift = await openShift({ userId: people.employeeId, initialCash: 500 });

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId: shift.id,
      lines: [{ productId, quantity: 1 }],
      customerId: people.memberId,
      // 200 points = 2 THB off, so 98 THB is handed over in cash.
      settlement: { points: 200, cash: 98, receivedCash: 100 },
    });

    expect(sale.tenders).toEqual([{ method: 'cash', amountThb: 98, receivedThb: 100 }]);
    expect(sale.changeThb).toBe(2);
  });

  it('prints both legs of a split payment, with the cash leg showing what was handed over', async () => {
    const productId = await withProduct(1, 155);
    const shift = await openShift({ userId: people.employeeId, initialCash: 500 });

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId: shift.id,
      lines: [{ productId, quantity: 1 }],
      customerId: null,
      settlement: { promptpay: 55, cash: 100, receivedCash: 150 },
    });

    // One line per money leg, in the order the settlement applied them.
    expect(sale.tenders).toEqual([
      { method: 'cash', amountThb: 100, receivedThb: 150 },
      { method: 'promptpay', amountThb: 55, receivedThb: null },
    ]);
    expect(sale.changeThb).toBe(50);
    // Only the cash leg carries change, so the two lines still foot to the bill.
    expect(sale.tenders.reduce((total, tender) => total + tenderedAmount(tender), 0)).toBe(
      sale.finalAmountThb + sale.changeThb,
    );
  });
});

describe('the messages an order leaves behind', () => {
  it('queues the shop a note at placement and the customer a code at packing', async () => {
    /*
     * The outbox is written by the order transaction, not after it, which is the
     * only reason a message cannot go missing when the process dies between
     * committing the order and telling anybody about it.
     */
    vi.stubEnv('NOTIFY_CHANNEL', 'webhook');
    vi.stubEnv('NOTIFY_STAFF_TO', '0800000001');
    try {
      const productId = await withProduct(10, 100);
      const placed = await placePreOrder({
        customerId: people.memberId,
        lines: [{ productId, quantity: 1 }],
      });
      await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
      const packed = await markOrderReady({
        orderId: placed.orderId,
        employeeId: people.employeeId,
      });

      const queued = await prisma.notifications.findMany({ orderBy: { id: 'asc' } });

      expect(queued.map((row) => row.kind)).toEqual(['pre_order_placed', 'order_ready']);
      // The shop's own note goes to the shop; the collection code goes to the
      // customer's phone and nowhere else.
      expect(queued[0]?.recipient).toBe('0800000001');
      expect(queued[1]?.recipient).toBe('0900000001');
      expect(queued[1]?.body).toContain(packed.pickupPin);
      expect(queued[0]?.body).toContain(placed.orderNumber);
      expect(queued.every((row) => row.status === 'pending' && row.attempts === 0)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('queues nothing at all when the shop has configured no channel', async () => {
    // The in-app path is the fallback, and it is not a degraded one: a shop with
    // no gateway gets no half-configured messages to clean up either.
    const productId = await withProduct(10, 100);
    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId, quantity: 1 }],
    });
    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });

    expect(await prisma.notifications.count()).toBe(0);
  });
});
