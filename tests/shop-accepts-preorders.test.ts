// Seam under test: whether this shop accepts pre-orders at all (ADR 0027's pattern,
// the second switch built on it).
//
// One seam and one rule: the shop either takes pre-orders or it does not, and the
// answer belongs to `placePreOrder` rather than to the screen that offers it. A
// member's browser is the only way in, so a rule that lived in the route or in the
// customer page would be one refactor away from a pre-order that nobody asked for.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma, resetDatabase, seedPeople, seedProduct, seedShop, type TestPeople } from './helpers/test-db';
import { ConflictError } from '@/lib/errors';
import { placePreOrder } from '@/lib/orders';
import { shopColumns } from '@/lib/shop';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function stopTakingPreOrders(): Promise<void> {
  await prisma.shops.update({ where: { id: 1 }, data: { accepts_preorders: false } });
}

function line(productId: string) {
  return [{ productId, quantity: 1 }];
}

describe('a shop that does not take pre-orders', () => {
  it('refuses the order, in the member\'s language, and writes nothing', async () => {
    await seedShop();
    await stopTakingPreOrders();
    const product = await seedProduct({ stockQty: 10 });

    // The sentence is the whole of what the customer is told, so it is asserted
    // literally: a refusal that drifts into English or into jargon is a refusal a
    // member cannot act on, and there is no one else to ask.
    await expect(placePreOrder({ customerId: people.memberId, lines: line(product.id) })).rejects.toThrow(
      'ร้านนี้ยังไม่เปิดรับพรีออเดอร์',
    );
    await expect(
      placePreOrder({ customerId: people.memberId, lines: line(product.id) }),
    ).rejects.toBeInstanceOf(ConflictError);

    const orders = await prisma.orders.count();
    expect(orders).toBe(0);
  });

  it('still places one for a shop that does take them', async () => {
    await seedShop();
    const product = await seedProduct({ stockQty: 10 });

    const placed = await placePreOrder({ customerId: people.memberId, lines: line(product.id) });

    expect(placed.orderNumber).toMatch(/^PO-/);
    const stored = await prisma.orders.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(stored.order_type).toBe('preorder');
    expect(stored.status).toBe('pending');
  });
});

describe('the shop settings save and its answer about pre-orders', () => {
  const SETTINGS = { name: 'ร้านทดสอบ', isVatRegistered: false, vatRate: 0, receiptPrefix: 'RC' };

  it('is written when the settings form sends it, and left alone when it does not', () => {
    /*
     * The second seam, and the one that decides whether the first can ever be
     * switched. `shopColumns` builds the UPDATE by hand, so a key it does not know
     * about is a key the owner cannot change — while a key it spreads
     * unconditionally is worse: a save from an older page, or the wizard's default
     * path, would answer "yes, we take pre-orders" for a shop that has said no.
     */
    expect(shopColumns({ ...SETTINGS, acceptsPreorders: false })).toMatchObject({
      accepts_preorders: false,
    });
    expect(shopColumns({ ...SETTINGS, acceptsPreorders: true })).toMatchObject({
      accepts_preorders: true,
    });
    expect(Object.keys(shopColumns(SETTINGS))).not.toContain('accepts_preorders');
  });
});
