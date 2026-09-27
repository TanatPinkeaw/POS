// Seam under test: `placePreOrder`, the Phase 1 entry point, under genuine
// concurrency against a real PostgreSQL server.
//
// This is the SRS's central correctness claim (§4.2): simultaneous reservations
// must not oversell, and the rejection must be a 409 rather than a silent
// over-commitment.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InsufficientStockError } from '@/lib/errors';
import { placePreOrder } from '@/lib/orders';

import { prisma, readCounters, resetDatabase, seedPeople, seedProduct } from './helpers/test-db';

const STOCK = 20;
const CONTENDERS = 50;

describe('concurrent pre-order reservations', () => {
  let memberId: string;
  let productId: string;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    const people = await seedPeople();
    memberId = people.memberId;
    const product = await seedProduct({ name: 'สินค้าชิงสต็อก', stockQty: STOCK, salePrice: 50 });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('lets exactly as many through as there is stock, and rejects the rest with 409', async () => {
    const attempts = Array.from({ length: CONTENDERS }, () =>
      placePreOrder({ customerId: memberId, lines: [{ productId, quantity: 1 }] }),
    );

    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    // The whole point: no more than STOCK may succeed, and every failure must be
    // the domain error the API maps to HTTP 409.
    expect(fulfilled).toHaveLength(STOCK);
    expect(rejected).toHaveLength(CONTENDERS - STOCK);

    for (const failure of rejected) {
      expect(failure.reason).toBeInstanceOf(InsufficientStockError);
      expect((failure.reason as InsufficientStockError).httpStatus).toBe(409);
    }

    const counters = await readCounters(productId);
    expect(counters.reservedQty).toBe(STOCK);
    expect(counters.stockQty).toBe(STOCK);
    // Available is exhausted, so the product is genuinely off sale.
    expect(counters.stockQty - counters.reservedQty).toBe(0);
  });

  it('writes one order row per successful reservation, never more', async () => {
    await Promise.allSettled(
      Array.from({ length: CONTENDERS }, () =>
        placePreOrder({ customerId: memberId, lines: [{ productId, quantity: 1 }] }),
      ),
    );

    const orderCount = await prisma.orders.count({ where: { order_type: 'preorder' } });
    expect(orderCount).toBe(STOCK);
  });

  it('never leaves a reservation audit row behind for a rejected attempt', async () => {
    await Promise.allSettled(
      Array.from({ length: CONTENDERS }, () =>
        placePreOrder({ customerId: memberId, lines: [{ productId, quantity: 1 }] }),
      ),
    );

    // A rolled-back attempt must leave no stock_logs: the audit trail has to
    // describe what actually happened, not what was attempted.
    const logs = await prisma.stock_logs.count({
      where: { product_id: productId, movement_type: 'preorder_reserve' },
    });
    expect(logs).toBe(STOCK);
  });

  it('holds the line when a multi-unit request competes for the last units', async () => {
    await resetDatabase();
    const people = await seedPeople();
    const product = await seedProduct({ name: 'สินค้าชิ้นใหญ่', stockQty: 10, salePrice: 90 });

    // Ten orders of two units against ten units of stock: exactly five fit.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        placePreOrder({ customerId: people.memberId, lines: [{ productId: product.id, quantity: 2 }] }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(5);

    const counters = await readCounters(product.id);
    expect(counters.reservedQty).toBe(10);
    expect(counters.stockQty - counters.reservedQty).toBe(0);
  });

  it('counts duplicate lines in one cart as a single larger request', async () => {
    await resetDatabase();
    const people = await seedPeople();
    // 15 units of stock; asking for the same product twice must be treated as
    // one request for 16, not as two requests that each individually fit.
    const product = await seedProduct({ name: 'สินค้าซ้ำ', stockQty: 15, salePrice: 10 });

    await expect(
      placePreOrder({
        customerId: people.memberId,
        lines: [
          { productId: product.id, quantity: 8 },
          { productId: product.id, quantity: 8 },
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    const counters = await readCounters(product.id);
    expect(counters.reservedQty).toBe(0);
  });
});
