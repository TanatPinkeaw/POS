// Seam under test: a refund of a consigned sale debits the consignor's payable by the
// share the sale credited (ADR 0023 §6).
//
// The sale side (`consignment-sale.test.ts`) proves a sale credits the share. This file
// proves the reversal stays tied to *that* credit rather than recomputing it: the debit
// is written in the refund's own transaction, is proportional to the units that came
// back, and lands the balance exactly on zero when the line closes — however many
// visits that takes. The one thing it must never do is block the customer: a payout
// already taken just lets the balance go negative, and the next payout nets it.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { setConsignment } from '@/lib/consignment';
import { refundOrder } from '@/lib/credit-notes';
import { createPosSale } from '@/lib/orders';

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

/** A VAT-registered shop and an open drawer, so a cash refund is allowed. */
async function shopAndShift(): Promise<number> {
  await seedShop({ isVatRegistered: true, vatRate: 7 });
  return seedOpenShift(people.employeeId);
}

/**
 * The sum of every signed movement — the balance a payout would be checked against.
 * Summed in satang, because that is how the ledger's own `ledgerBalance` sums and
 * adding two-decimal floats drifts by a rounding error on the third row.
 */
async function balanceFor(consignorUserId: string): Promise<number> {
  const rows = await prisma.consignor_payables.findMany({
    where: { consignor_user_id: consignorUserId },
  });
  const satang = rows.reduce((total, row) => total + Math.round(Number(row.amount_thb) * 100), 0);
  return satang / 100;
}

async function saleItemId(orderId: string): Promise<string> {
  const item = await prisma.order_items.findFirstOrThrow({
    where: { order_id: orderId },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  return item.id.toString();
}

/** Sells `quantity` at `unitPrice` (VAT-inclusive) and returns the sale and its line. */
async function sell(
  shiftId: number,
  productId: string,
  quantity: number,
  unitPrice = 107,
): Promise<{ orderId: string; itemId: string }> {
  const sale = await createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId, quantity }],
    customerId: null,
    settlement: { cash: unitPrice * quantity },
  });
  return { orderId: sale.orderId, itemId: await saleItemId(sale.orderId) };
}

describe('refunding a consigned sale', () => {
  it('debits the share the sale credited, returning the balance to zero', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ name: 'กาแฟฝากขาย', salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);

    const { orderId, itemId } = await sell(shiftId, product.id, 1);
    const credit = await prisma.consignor_payables.findFirstOrThrow({
      where: { order_id: orderId, kind: 'sale' },
    });
    expect(Number(credit.amount_thb)).toBe(40);

    await refundOrder({
      orderId,
      actorId: people.employeeId,
      reason: 'ลูกค้าคืนของ',
      refundMethod: 'cash',
      shiftId,
    });

    const debit = await prisma.consignor_payables.findFirstOrThrow({
      where: { order_id: orderId, kind: 'refund' },
    });
    expect(Number(debit.amount_thb)).toBe(-40);
    // Reachable from the same line the credit named.
    expect(debit.order_item_id?.toString()).toBe(itemId);
    expect(debit.product_id).toBe(product.id);
    expect(await balanceFor(people.memberId)).toBe(0);
  });

  it('debits only the returned units’ share on a partial refund', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 10 });
    await consign(product.id, 40);

    // Three units at ฿107 gross → ฿300 net → a ฿120 share; one back is ฿40.
    const { orderId, itemId } = await sell(shiftId, product.id, 3);
    expect(await balanceFor(people.memberId)).toBe(120);

    await refundOrder({
      orderId,
      actorId: people.employeeId,
      reason: 'คืนหนึ่งชิ้น',
      refundMethod: 'cash',
      shiftId,
      lines: [{ orderItemId: itemId, quantity: 1 }],
    });

    const debit = await prisma.consignor_payables.findFirstOrThrow({
      where: { order_id: orderId, kind: 'refund' },
    });
    expect(Number(debit.amount_thb)).toBe(-40);
    expect(await balanceFor(people.memberId)).toBe(80);
  });

  it('settles the remainder on the note that closes the line, so the debits add to the credit', async () => {
    const shiftId = await shopAndShift();
    // Three units do not divide into whole satang shares, so the last visit must take
    // the remainder — not a third rounding — or the debits would miss the credit by a
    // satang and the balance would never reach zero.
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });
    await consign(product.id, 100);

    const { orderId, itemId } = await sell(shiftId, product.id, 3, 100);

    for (let i = 0; i < 2; i += 1) {
      await refundOrder({
        orderId,
        actorId: people.employeeId,
        reason: 'คืนทีละชิ้น',
        refundMethod: 'cash',
        shiftId,
        lines: [{ orderItemId: itemId, quantity: 1 }],
      });
    }
    await refundOrder({
      orderId,
      actorId: people.employeeId,
      reason: 'คืนชิ้นสุดท้าย',
      refundMethod: 'cash',
      shiftId,
      lines: [{ orderItemId: itemId, quantity: 1 }],
    });

    const debits = await prisma.consignor_payables.findMany({
      where: { order_id: orderId, kind: 'refund' },
    });
    expect(debits).toHaveLength(3);
    // The three debits are the credit, to the satang, and the balance is zero.
    expect(await balanceFor(people.memberId)).toBe(0);
  });

  it('writes nothing for a refunded line the shop owned', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });

    const { orderId } = await sell(shiftId, product.id, 1);
    await refundOrder({
      orderId,
      actorId: people.employeeId,
      reason: 'ลูกค้าคืนของ',
      refundMethod: 'cash',
      shiftId,
    });

    expect(await prisma.consignor_payables.count({ where: { order_id: orderId } })).toBe(0);
  });

  it('claws nothing back when the refund itself is refused', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 10 });
    await consign(product.id, 40);

    const { orderId, itemId } = await sell(shiftId, product.id, 1);

    await expect(
      refundOrder({
        orderId,
        actorId: people.employeeId,
        reason: 'คืนเกิน',
        refundMethod: 'cash',
        shiftId,
        lines: [{ orderItemId: itemId, quantity: 5 }],
      }),
    ).rejects.toThrow();

    // The sale's credit stands; no reversal row was written for the failed refund.
    expect(await prisma.consignor_payables.count({ where: { kind: 'refund' } })).toBe(0);
    expect(await balanceFor(people.memberId)).toBe(40);
  });

  it('carries a negative balance when a payout already went out, instead of blocking the refund', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);

    const { orderId } = await sell(shiftId, product.id, 1);
    // The share was paid out before the customer returned the item. The debit names
    // the statement it settles (ticket 08) — a payout row cannot stand alone.
    const payout = await prisma.consignor_payouts.create({
      data: {
        consignor_user_id: people.memberId,
        method: 'promptpay',
        amount_thb: 40,
        note: 'จ่ายส่วนแบ่ง',
        created_by: people.adminId,
      },
    });
    await prisma.consignor_payables.create({
      data: {
        consignor_user_id: people.memberId,
        kind: 'payout',
        amount_thb: -40,
        description: 'จ่ายส่วนแบ่ง',
        payout_id: payout.id,
      },
    });
    expect(await balanceFor(people.memberId)).toBe(0);

    await refundOrder({
      orderId,
      actorId: people.employeeId,
      reason: 'คืนของหลังจ่ายส่วนแบ่ง',
      refundMethod: 'cash',
      shiftId,
    });

    // The refund succeeded and left the debt the next payout will net against.
    expect(await balanceFor(people.memberId)).toBe(-40);
  });
});
