// Seam under test: the consignor's share is recorded in the sale's own transaction
// (ADR 0023 §5). There are exactly two places a sale completes — a walk-in bill
// (`createPosSale`) and a pre-order handover (`completeOrder`) — and each must write
// one payable credit per consigned line, computed by the pure rule from the line's net
// excluding VAT.
//
// The two properties worth a real database are the ones a unit test cannot show: the
// credit is written *with* the sale (so a rolled-back sale owes nobody), and the share
// comes from the order's own frozen net rather than a recomputation that could drift.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { setConsignment } from '@/lib/consignment';
import { shareFromSale } from '@/lib/consignment-rules';
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

/** Consigns a product to the seeded member at an agreed share. */
async function consign(productId: string, sharePercent: number): Promise<void> {
  await prisma.$transaction((tx) =>
    setConsignment(tx, {
      productId,
      consignorUserId: people.memberId,
      sharePercent,
      actorId: people.adminId,
    }),
  );
}

/** A VAT-registered shop, so the net the share is taken of is not the gross. */
async function shopAndShift(): Promise<number> {
  await seedShop({ isVatRegistered: true, vatRate: 7 });
  return seedOpenShift(people.employeeId);
}

describe('a walk-in sale', () => {
  it('writes one credit per consigned line, taken from the line’s net excluding VAT', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ name: 'กาแฟฝากขาย', salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId: product.id, quantity: 1 }],
      customerId: null,
      settlement: { cash: 107 },
    });

    // ฿107 inclusive of 7% VAT is ฿100 net, and 40% of that is ฿40.
    expect(sale.netThb).toBe(100);

    const rows = await prisma.consignor_payables.findMany({ where: { order_id: sale.orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'sale', consignor_user_id: people.memberId });
    expect(Number(rows[0]?.amount_thb)).toBe(shareFromSale(sale.netThb, 40));
    expect(Number(rows[0]?.amount_thb)).toBe(40);
    // Reachable from the sale it belongs to, not only from the amount.
    expect(rows[0]?.order_item_id).not.toBeNull();
    expect(rows[0]?.product_id).toBe(product.id);
  });

  it('writes nothing for a shop-owned line', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId: product.id, quantity: 1 }],
      customerId: null,
      settlement: { cash: 100 },
    });

    expect(await prisma.consignor_payables.count({ where: { order_id: sale.orderId } })).toBe(0);
  });

  it('writes a credit only for the consigned line of a mixed cart', async () => {
    const shiftId = await shopAndShift();
    const owned = await seedProduct({ name: 'ของร้าน', salePrice: 50, stockQty: 5 });
    const consigned = await seedProduct({ name: 'ของฝากขาย', salePrice: 100, stockQty: 5 });
    await consign(consigned.id, 30);

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [
        { productId: owned.id, quantity: 1 },
        { productId: consigned.id, quantity: 2 },
      ],
      customerId: null,
      settlement: { cash: 250 },
    });

    const rows = await prisma.consignor_payables.findMany({ where: { order_id: sale.orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.product_id).toBe(consigned.id);
    // ฿200 of the ฿250 net belongs to the consigned line; 30% of that is ฿60.
    const consignedNet = (sale.netThb * 200) / 250;
    expect(Number(rows[0]?.amount_thb)).toBe(shareFromSale(consignedNet, 30));
  });

  it('owes nobody when the sale rolls back', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 100, stockQty: 1 });
    await consign(product.id, 50);

    // A settlement that does not cover the bill aborts the whole transaction after the
    // payable would have been written — the credit must roll back with the sale.
    await expect(
      createPosSale({
        cashierId: people.employeeId,
        shiftId,
        lines: [{ productId: product.id, quantity: 1 }],
        customerId: null,
        settlement: { cash: 1 },
      }),
    ).rejects.toThrow();

    expect(await prisma.consignor_payables.count()).toBe(0);
    expect(await prisma.orders.count()).toBe(0);
  });
});

describe('a pre-order handover', () => {
  it('credits at handover, not at placement', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ name: 'จองฝากขาย', salePrice: 107, stockQty: 5 });
    await consign(product.id, 25);

    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });
    // Placement reserves stock but records nothing owed.
    expect(await prisma.consignor_payables.count()).toBe(0);

    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });

    const completed = await completeOrder({
      orderId: placed.orderId,
      employeeId: people.employeeId,
      shiftId,
      settlement: { cash: 107 },
    });

    // ฿100 net at handover, 25% of it is ฿25.
    expect(completed.netThb).toBe(100);
    const rows = await prisma.consignor_payables.findMany({ where: { order_id: placed.orderId } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.amount_thb)).toBe(25);
  });

  it('writes nothing for a shop-owned pre-order', async () => {
    const shiftId = await shopAndShift();
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

    expect(await prisma.consignor_payables.count()).toBe(0);
  });

  it('owes nobody when the handover rolls back', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });
    await consign(product.id, 50);

    const placed = await placePreOrder({
      customerId: people.memberId,
      lines: [{ productId: product.id, quantity: 1 }],
    });
    await confirmOrder({ orderId: placed.orderId, employeeId: people.employeeId });
    await markOrderReady({ orderId: placed.orderId, employeeId: people.employeeId });

    await expect(
      completeOrder({
        orderId: placed.orderId,
        employeeId: people.employeeId,
        shiftId,
        settlement: { cash: 1 },
      }),
    ).rejects.toThrow();

    expect(await prisma.consignor_payables.count()).toBe(0);
    // The order is still packed — the rollback undid the handover, not the reservation.
    const stored = await prisma.orders.findUniqueOrThrow({ where: { id: placed.orderId } });
    expect(stored.status).toBe('ready_for_pickup');
  });
});

describe('the ledger balance', () => {
  it('accumulates across two sales of the same consignor', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 100, stockQty: 5 });
    await consign(product.id, 50);

    const nets: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const sale = await createPosSale({
        cashierId: people.employeeId,
        shiftId,
        lines: [{ productId: product.id, quantity: 1 }],
        customerId: null,
        settlement: { cash: 100 },
      });
      nets.push(sale.netThb);
    }

    const rows = await prisma.consignor_payables.findMany({ where: { kind: 'sale' } });
    expect(rows).toHaveLength(2);
    // Each sale credits its own line's net; the balance is the signed sum, which is what
    // a payout will later be checked against (ADR 0023 §2).
    const balance = rows.reduce((total, row) => total + Number(row.amount_thb), 0);
    const expected = nets.reduce((total, net) => total + shareFromSale(net, 50), 0);
    expect(balance).toBe(expected);
  });
});
