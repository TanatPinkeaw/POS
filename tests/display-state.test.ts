// Seam under test: what a customer screen is told when no event is telling it
// anything.
//
// The socket carries changes. This covers the other half — the facts that were
// already true when the screen came online: what the shop is called, what it
// sells most of, and which pre-orders are waiting. Two things here are worth
// testing rather than trusting: that the idle board's "shop is open" flag follows
// a real cash drawer instead of being hardcoded, and that the collection board
// carries an *initial* rather than a name, because that board faces a queue.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { buildDisplayState, buildIdlePayload, buildReadyPayload } from '@/lib/display-broadcast';
import { prisma, resetDatabase, seedOpenShift, seedPeople, seedProduct, seedShop, type TestPeople } from './helpers/test-db';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A completed walk-in sale of `quantity` units, so the best-seller query has data. */
async function completedSale(name: string, quantity: number): Promise<void> {
  const product = await seedProduct({ name, stockQty: 0, salePrice: 10, costPrice: 5 });
  const order = await prisma.orders.create({
    data: {
      order_number: `T${Math.random().toString(36).slice(2, 10)}`,
      order_type: 'pos_walkin',
      status: 'completed',
      completed_at: new Date(),
    },
  });
  await prisma.order_items.create({
    data: {
      order_id: order.id,
      product_id: product.id,
      unit_price: 10,
      unit_cost: 5,
      quantity,
      total_price: 10 * quantity,
    },
  });
}

/** A pre-order in one status, optionally attached to the seeded member. */
async function preOrder(
  status: 'pending' | 'ready_for_pickup' | 'completed',
  withCustomer: boolean,
): Promise<string> {
  const order = await prisma.orders.create({
    data: {
      order_number: `P${Math.random().toString(36).slice(2, 10)}`,
      order_type: 'preorder',
      status,
      customer_id: withCustomer ? people.memberId : null,
      ready_at: status === 'ready_for_pickup' ? new Date() : null,
    },
  });
  return order.order_number;
}

describe('the idle board', () => {
  it('falls back to a name of its own before the shop is set up', async () => {
    const idle = await buildIdlePayload();

    expect(idle.shopName).toBe('ร้านของฉัน');
    expect(idle.logoUrl).toBeNull();
    expect(idle.popular).toEqual([]);
    // No shop, no drawer, so nothing to claim.
    expect(idle.sessionOpen).toBe(false);
  });

  it('reflects a real cash drawer rather than assuming the shop is open', async () => {
    await seedShop();

    expect((await buildIdlePayload()).sessionOpen).toBe(false);

    await seedOpenShift(people.employeeId);
    expect((await buildIdlePayload()).sessionOpen).toBe(true);
  });

  it('names the shop and hides nothing behind the configuration', async () => {
    await seedShop();
    const idle = await buildIdlePayload();

    expect(idle.shopName).toBe('ร้านทดสอบ');
  });

  it('orders the best sellers by units sold, not by line count', async () => {
    await seedShop();
    await completedSale('กาแฟ', 2);
    await completedSale('กาแฟ', 3);
    await completedSale('ขนมปัง', 1);

    const idle = await buildIdlePayload();

    expect(idle.popular[0]).toBe('กาแฟ');
    expect(idle.popular).toContain('ขนมปัง');
  });

  it('leaves out anything that has not actually been sold', async () => {
    await seedShop();
    // In stock and visible, but never in a completed order: an idle board is a
    // record of takings, not a catalogue.
    await seedProduct({ name: 'ของใหม่', stockQty: 5 });

    expect((await buildIdlePayload()).popular).toEqual([]);
  });
});

describe('the collection board', () => {
  it('lists pre-orders that are packed, with an initial rather than a name', async () => {
    await seedShop();
    const orderNumber = await preOrder('ready_for_pickup', true);

    const board = await buildReadyPayload();

    expect(board.orders).toHaveLength(1);
    expect(board.orders[0]?.orderNumber).toBe(orderNumber);
    // The seeded member is "ลูกค้า"; the board may show "ล." and nothing more.
    expect(board.orders[0]?.customerInitial).toBe('ล.');
  });

  it('leaves out orders that are not waiting to be collected', async () => {
    await seedShop();
    await preOrder('pending', true);
    await preOrder('completed', true);

    expect((await buildReadyPayload()).orders).toEqual([]);
  });

  it('tolerates a walk-in order that has no customer attached', async () => {
    await seedShop();
    await preOrder('ready_for_pickup', false);

    const board = await buildReadyPayload();
    expect(board.orders[0]?.customerInitial).toBeNull();
  });
});

describe('the state a screen fetches on arrival', () => {
  it('carries the idle board and the collection board together', async () => {
    await seedShop();
    await seedOpenShift(people.employeeId);
    const orderNumber = await preOrder('ready_for_pickup', true);

    const state = await buildDisplayState();

    expect(state.idle.shopName).toBe('ร้านทดสอบ');
    expect(state.idle.sessionOpen).toBe(true);
    expect(state.ready.orders.map((order) => order.orderNumber)).toEqual([orderNumber]);
  });
});
