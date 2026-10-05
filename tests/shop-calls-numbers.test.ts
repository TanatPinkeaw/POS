// Seam under test: whether this shop calls its customers by number at all (ADR 0027).
//
// The switch is one boolean, and the whole of the feature hangs off it, so the
// tests are deliberately in one file: the sale, the counter statement, the
// device's borrowed numbers and the number the offline rules hand back are four
// views of "does this shop call anybody", and a switch that works in three of them
// is a switch that prints a number nobody can be called by.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma, resetDatabase, seedOpenShift, seedPeople, seedProduct, seedShop, type TestPeople } from './helpers/test-db';
import { createPosSale } from '@/lib/orders';
import { decideOfflineSale, type OfflineBasket, type OfflineSaleContext, type OfflineSaleDecision } from '@/lib/offline-sale-rules';
import { allocateQueueNumber, shopColumns } from '@/lib/shop';
import {
  createTillStore,
  type HeldBlock,
  type PersistedTill,
  type TillSnapshot,
  type TillStorage,
} from '@/lib/till-store';
import { bangkokDateString } from '@/lib/bangkok-time';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function turnOff(): Promise<void> {
  await prisma.shops.update({ where: { id: 1 }, data: { calls_numbers: false } });
}

async function turnOn(): Promise<void> {
  await prisma.shops.update({ where: { id: 1 }, data: { calls_numbers: true } });
}

/** Reads the one row directly, so the assertion cannot be satisfied by a view. */
async function readShop(): Promise<{ callsNumbers: boolean; queueRunningNumber: number }> {
  const row = await prisma.shops.findUniqueOrThrow({ where: { id: 1 } });
  return { callsNumbers: row.calls_numbers, queueRunningNumber: row.queue_running_number };
}

async function sell(productId: string, shiftId: number) {
  return createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId, quantity: 1 }],
    customerId: null,
    settlement: { cash: 100 },
  });
}

describe('a shop that does not call its customers', () => {
  it('issues no number and mints no ticket', async () => {
    await seedShop();
    await turnOff();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ stockQty: 10 });

    const summary = await sell(product.id, shiftId);
    const order = await prisma.orders.findUniqueOrThrow({ where: { id: summary.orderId } });

    expect(order.queue_number).toBeNull();
    expect(order.queue_day).toBeNull();
    expect(order.fulfilment).toBeNull();
  });

  it('leaves the counter alone, so the day it turns back on starts at one', async () => {
    await seedShop();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ stockQty: 10 });

    await sell(product.id, shiftId);
    expect((await readShop()).queueRunningNumber).toBe(1);

    await turnOff();
    await sell(product.id, shiftId);
    // The bill printed no number, so the counter must not have moved for it: a
    // shop that turns calling back on would otherwise start the day at a number
    // nobody has ever been called by.
    expect((await readShop()).queueRunningNumber).toBe(1);

    await turnOn();
    await sell(product.id, shiftId);
    expect((await readShop()).queueRunningNumber).toBe(2);
  });

  it('gives the counter statement nothing to hand back', async () => {
    await seedShop();
    await turnOff();
    expect(await allocateQueueNumber(prisma)).toBeNull();
    await turnOn();
    const allocated = await allocateQueueNumber(prisma);
    expect(allocated?.value).toBe(1);
  });

  it('leaves the column alone when a form does not mention it', () => {
    // A settings save that predates the switch, or the wizard's own default path,
    // must not answer a question it never asked.
    expect(Object.keys(shopColumns({ name: 'ร้านทดสอบ', isVatRegistered: false, vatRate: 0, receiptPrefix: 'RC' }))).not.toContain(
      'calls_numbers',
    );
    expect(shopColumns({ name: 'ร้านทดสอบ', isVatRegistered: false, vatRate: 0, receiptPrefix: 'RC', callsNumbers: false })).toMatchObject({
      calls_numbers: false,
    });
  });
});

describe('a device that sells for a shop which does not call', () => {
  const AT = new Date('2026-10-05T04:00:00.000Z');
  const TODAY = bangkokDateString(AT);

  const CALL_BLOCK: HeldBlock = {
    id: 'loan-call',
    block: { kind: 'queue', day: TODAY, from: 1, to: 100, lastUsed: null },
  };

  function context(overrides: Partial<OfflineSaleContext> = {}): OfflineSaleContext {
    return {
      at: AT,
      shiftOpen: true,
      supervisorDiscountLimitThb: 50,
      isVatRegistered: false,
      callsNumbers: true,
      vatRatePercent: 7,
      pricesIncludeVat: true,
      receiptPrefix: 'FR',
      catalogue: [{ productId: 'p-coffee', name: 'กาแฟเย็น', priceThb: 45, available: 10, safetyQty: 0, isActive: true, consigned: false }],
      callBlocks: [CALL_BLOCK.block],
      receiptBlock: null,
      pending: [],
      ...overrides,
    } as OfflineSaleContext;
  }

  function memoryStorage(): TillStorage & { state: PersistedTill | null } {
    const storage = {
      // `persists` is how the store knows this device can keep its state at all,
      // and a prepared till is only preparable on a device that can.
      persists: true,
      state: null as PersistedTill | null,
      read: () => Promise.resolve(storage.state),
      write: (next: PersistedTill) => {
        storage.state = next;
        return Promise.resolve();
      },
    };
    return storage;
  }

  const basket: OfflineBasket = {
    lines: [{ productId: 'p-coffee', quantity: 1 }],
    tender: 'cash',
    memberAttached: false,
    pointsRedeemed: 0,
    discountThb: 0,
  };

  /** The allowed answer, or a thrown assertion naming what refused it. */
  function allowed(decision: OfflineSaleDecision) {
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      throw new Error('refused: ' + decision.refusals.map((r) => r.message).join(' | '));
    }
    return decision;
  }

  it('prints no number and complains about nothing', () => {
    const decision = allowed(decideOfflineSale(basket, context({ callsNumbers: false })));
    expect(decision.callNumber).toBeNull();
    // Running out of a series nobody uses is not a shortfall, so the warning the
    // "no call number" case raises must not appear either.
    expect(decision.warnings).toHaveLength(0);
  });

  it('leaves the borrowed block unspent, so turning the switch back on still has numbers', () => {
    const first = allowed(decideOfflineSale(basket, context({ callsNumbers: false })));
    const later = allowed(decideOfflineSale(basket, context({ callsNumbers: true })));
    expect(later.callNumber).toEqual({ value: 1, day: TODAY });
    // The first sale left the block exactly as it found it, and the one value spent
    // is the *second* sale's: a shop that turns calling back on has its numbers
    // where it left them rather than one short.
    expect(first.callBlocks).toEqual([{ ...CALL_BLOCK.block, lastUsed: null }]);
    expect(later.callBlocks).toEqual([{ ...CALL_BLOCK.block, lastUsed: 1 }]);
  });

  it('borrows no queue series when the till is prepared', async () => {
    const borrow = vi.fn(async (request: { id: string; series: 'receipt' | 'queue'; day: string | null; size: number; deviceLabel: string }) => ({
      id: request.id,
      kind: request.series,
      day: request.day,
      from: 1,
      to: request.size,
      lastUsed: null,
    }));
    const storage = memoryStorage();
    const store = createTillStore({
      storage,
      transport: { borrow, sync: async () => ({ bills: [], reports: [], notAttempted: 0 }) },
      deviceLabel: 'เครื่องหน้าร้าน',
      now: () => AT,
      newClientRef: () => 'ref-1',
    });
    await store.load();
    await store.saveSnapshot({
      capturedAt: AT.toISOString(),
      deviceLabel: 'เครื่องหน้าร้าน',
      shop: {
        isVatRegistered: false,
        callsNumbers: false,
        vatRatePercent: 7,
        pricesIncludeVat: true,
        receiptPrefix: 'FR',
        supervisorDiscountLimitThb: 50,
      },
      catalogue: [{ productId: 'p-coffee', name: 'กาแฟเย็น', priceThb: 45, available: 10, safetyQty: 0, isActive: true, consigned: false }],
      shift: {
        id: 7,
        initialCashThb: 2000,
        openedAt: AT.toISOString(),
        cashSalesThb: 0,
        cashPayoutsThb: 0,
        expectedCashThb: 2000,
        orderCount: 0,
      },
      heldBlocks: [],
    });

    await store.prepare('เครื่องหน้าร้าน');

    // Nothing at all is borrowed: the shop is not VAT-registered and does not call
    // numbers, so there is no series for it to hold. A loan it will never spend
    // freezes those numbers away from the server.
    expect(borrow).not.toHaveBeenCalled();
  });
});