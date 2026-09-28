// Seam under test: giving a customer back *part* of a bill, against a real
// database.
//
// The pure half (`refund-plan.test.ts`) pins what each note is worth. This file pins
// what happens around it, which is where a partial refund goes wrong in a way nobody
// notices: a bill that was credited three times without the notes reaching the
// invoice, a second visit that hands back stock twice, points clawed back once per
// visit instead of once per purchase.
//
// The property every case here is really checking is the same one: **the notes,
// added up, are the sale.**
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  creditNoteHistoryFor,
  listCreditNoteDocuments,
  loadCreditNoteDocument,
  refundOrder,
  refundedAmountFor,
} from '@/lib/credit-notes';
import { ConflictError, ValidationError } from '@/lib/errors';
import { createPosSale } from '@/lib/orders';
import { roundThb, sumThb } from '@/lib/money';

import {
  prisma,
  readCounters,
  readSeries,
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
  await seedShop();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A three-line bill with an order-level discount: ฿100 + ฿100 + ฿100 less ฿10, so
 * ฿290 paid across three lines. Every figure in the cases below comes off this sale,
 * including the awkward ones — a third of ฿10 is not a whole number of satang.
 */
async function sellThree(): Promise<{
  sale: { orderId: string; orderNumber: string; finalAmountThb: number };
  items: { orderItemId: string; productId: string; name: string }[];
  shiftId: number;
}> {
  const coffee = await seedProduct({ name: 'กาแฟ', stockQty: 10, salePrice: 100, costPrice: 40 });
  const water = await seedProduct({ name: 'น้ำเปล่า', stockQty: 10, salePrice: 100, costPrice: 10 });
  const bread = await seedProduct({ name: 'ขนมปัง', stockQty: 10, salePrice: 100, costPrice: 30 });
  const shiftId = await seedOpenShift(people.employeeId, 500);

  const sale = await createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [
      { productId: coffee.id, quantity: 1 },
      { productId: water.id, quantity: 1 },
      { productId: bread.id, quantity: 1 },
    ],
    customerId: null,
    manualDiscountThb: 10,
    settlement: { cash: 290 },
  });

  const items = await prisma.order_items.findMany({
    where: { order_id: sale.orderId },
    orderBy: { id: 'asc' },
    select: { id: true, product_id: true, product: { select: { name: true } } },
  });

  return {
    sale,
    items: items.map((item) => ({
      orderItemId: item.id.toString(),
      productId: item.product_id,
      name: item.product.name,
    })),
    shiftId,
  };
}

async function refund(
  orderId: string,
  lines: { orderItemId: string; quantity: number }[] | null,
  shiftId: number,
) {
  return refundOrder({
    orderId,
    actorId: people.employeeId,
    reason: 'ลูกค้าคืนของ',
    refundMethod: 'cash',
    shiftId,
    lines,
  });
}

describe('refunding one line of three', () => {
  it('gives back that line, less its share of the discount', async () => {
    const { sale, items } = await sellThree();
    const water = items[1]!;

    const note = await refund(sale.orderId, [{ orderItemId: water.orderItemId, quantity: 1 }], 1);

    expect(note.partial).toBe(true);
    expect(note.sequence).toBe(1);
    expect(note.grossAmountThb).toBe(100);
    expect(note.discountThb).toBe(3.33);
    expect(note.finalAmountThb).toBe(96.67);
    // A partly credited bill is still a completed sale: the invoice stands, and the
    // note is what records that some of it came back.
    expect(note.status).toBe('completed');
  });

  it('puts only that line back on the shelf', async () => {
    const { sale, items } = await sellThree();
    const water = items[1]!;

    await refund(sale.orderId, [{ orderItemId: water.orderItemId, quantity: 1 }], 1);

    expect(await readCounters(items[0]!.productId)).toEqual({ stockQty: 9, reservedQty: 0 });
    expect(await readCounters(water.productId)).toEqual({ stockQty: 10, reservedQty: 0 });
    expect(await readCounters(items[2]!.productId)).toEqual({ stockQty: 9, reservedQty: 0 });
  });

  it('itemises the note, so the document says what it reversed', async () => {
    const { sale, items } = await sellThree();
    const water = items[1]!;

    const document = await loadCreditNoteDocument(sale.orderId);

    const note = await refund(sale.orderId, [{ orderItemId: water.orderItemId, quantity: 1 }], 1);
    const after = await loadCreditNoteDocument(sale.orderId);

    expect(document).toBeNull();
    expect(after?.lines).toEqual([
      { name: 'น้ำเปล่า', quantity: 1, unitPrice: 100, totalPrice: 100 },
    ]);
    expect(after?.documentNumber).toBe(note.documentNumber);
    expect(after?.isPartial).toBe(true);
    // The document's own arithmetic, which is what the customer reads. Rounded
    // because this assertion does the subtraction in baht, and 100 − 3.33 is
    // 96.66999999999999 as a float — the module works in satang for this reason.
    expect(roundThb(after!.grossAmountThb - after!.discountThb)).toBe(after!.finalAmountThb);
    expect(roundThb((after?.netThb ?? 0) + (after?.vatThb ?? 0))).toBe(after?.finalAmountThb);
  });

  it('writes one refund leg, not one per original tender', async () => {
    const { sale, items } = await sellThree();

    await refund(sale.orderId, [{ orderItemId: items[0]!.orderItemId, quantity: 1 }], 1);

    const refundLegs = await prisma.payments.findMany({
      where: { order_id: sale.orderId, direction: 'refund' },
    });
    expect(refundLegs).toHaveLength(1);
    expect(Number(refundLegs[0]?.amount)).toBe(96.67);
  });
});

describe('refunding the rest afterwards', () => {
  it('closes the sale, and the two notes are the invoice', async () => {
    const { sale, items } = await sellThree();

    const first = await refund(sale.orderId, [{ orderItemId: items[1]!.orderItemId, quantity: 1 }], 1);
    const second = await refund(sale.orderId, null, 1);

    expect(second.sequence).toBe(2);
    expect(second.partial).toBe(false);
    expect(second.status).toBe('refunded');
    expect(sumThb([first.finalAmountThb, second.finalAmountThb])).toBe(sale.finalAmountThb);
    expect(sumThb([first.discountThb, second.discountThb])).toBe(10);
    expect(await refundedAmountFor(sale.orderId)).toBe(sale.finalAmountThb);
  });

  it('reconstructs the sale’s own tax exactly across the two notes', async () => {
    const { sale, items } = await sellThree();
    const order = await prisma.orders.findUniqueOrThrow({ where: { id: sale.orderId } });

    await refund(sale.orderId, [{ orderItemId: items[0]!.orderItemId, quantity: 1 }], 1);
    await refund(sale.orderId, null, 1);

    const notes = await prisma.credit_notes.findMany({ where: { order_id: sale.orderId } });

    expect(sumThb(notes.map((note) => Number(note.net_amount)))).toBe(Number(order.net_amount));
    expect(sumThb(notes.map((note) => Number(note.vat_amount)))).toBe(Number(order.vat_amount));
    expect(sumThb(notes.map((note) => Number(note.final_amount)))).toBe(
      Number(order.final_amount),
    );
  });

  it('returns every unit exactly once', async () => {
    const { sale, items } = await sellThree();

    await refund(sale.orderId, [{ orderItemId: items[0]!.orderItemId, quantity: 1 }], 1);
    await refund(sale.orderId, null, 1);

    for (const item of items) {
      expect(await readCounters(item.productId), item.name).toEqual({ stockQty: 10, reservedQty: 0 });
    }
  });

  it('leaves a history an order screen can show, newest first', async () => {
    const { sale, items } = await sellThree();

    const first = await refund(sale.orderId, [{ orderItemId: items[2]!.orderItemId, quantity: 1 }], 1);
    const second = await refund(sale.orderId, null, 1);

    const history = await creditNoteHistoryFor(sale.orderId);
    expect(history.map((note) => note.sequence)).toEqual([1, 2]);
    expect(history[1]?.isLast).toBe(true);
    expect(history[0]?.amountThb).toBe(first.finalAmountThb);

    const documents = await listCreditNoteDocuments(sale.orderId);
    expect(documents.map((document) => document.documentNumber)).toEqual([
      second.documentNumber,
      first.documentNumber,
    ]);
    // The first note is partial even now that the sale is closed: it is a document
    // that was issued, and a reprint of it must say what it said.
    expect(documents[1]?.isPartial).toBe(true);
    expect(documents[0]?.isPartial).toBe(false);
  });

  it('refuses to refund anything once the sale is closed', async () => {
    const { sale } = await sellThree();

    await refund(sale.orderId, null, 1);

    await expect(refund(sale.orderId, null, 1)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('part of one line', () => {
  async function sellFiveCoffees() {
    const coffee = await seedProduct({ name: 'กาแฟ', stockQty: 10, salePrice: 101, costPrice: 40 });
    const shiftId = await seedOpenShift(people.employeeId, 500);
    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [{ productId: coffee.id, quantity: 5 }],
      customerId: null,
      settlement: { cash: 505 },
    });
    const item = await prisma.order_items.findFirstOrThrow({ where: { order_id: sale.orderId } });
    return { sale, productId: coffee.id, orderItemId: item.id.toString() };
  }

  it('returns two of the five, and only two', async () => {
    const { sale, productId, orderItemId } = await sellFiveCoffees();

    const note = await refund(sale.orderId, [{ orderItemId, quantity: 2 }], 1);

    expect(note.returnedUnits).toBe(2);
    expect(note.finalAmountThb).toBe(202);
    expect(await readCounters(productId)).toEqual({ stockQty: 7, reservedQty: 0 });
  });

  it('and the remaining three close it', async () => {
    const { sale, productId, orderItemId } = await sellFiveCoffees();

    await refund(sale.orderId, [{ orderItemId, quantity: 2 }], 1);
    const closing = await refund(sale.orderId, null, 1);

    expect(closing.returnedUnits).toBe(3);
    expect(closing.status).toBe('refunded');
    expect(await readCounters(productId)).toEqual({ stockQty: 10, reservedQty: 0 });
  });

  it('refuses more units than are left', async () => {
    const { sale, productId, orderItemId } = await sellFiveCoffees();

    await refund(sale.orderId, [{ orderItemId, quantity: 3 }], 1);

    // Two left, so three is a request the till has to have made by mistake — and
    // the refusal leaves the shelf exactly as the first note left it.
    await expect(
      refund(sale.orderId, [{ orderItemId, quantity: 3 }], 1),
    ).rejects.toBeInstanceOf(ValidationError);
    // Eight: five came off the shelf when they were sold, three went back.
    expect(await readCounters(productId)).toEqual({ stockQty: 8, reservedQty: 0 });
  });

  it('refuses a line that has already gone back in full', async () => {
    const { sale, orderItemId } = await sellFiveCoffees();

    await refund(sale.orderId, [{ orderItemId, quantity: 5 }], 1);
    // The sale is closed by that note, so the refusal is the state machine's —
    // and the route's approval target is the order, which no longer has anything
    // to refund.
    await expect(
      refund(sale.orderId, [{ orderItemId, quantity: 5 }], 1),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('what a partial refund does to the loyalty ledger', () => {
  async function sellThreeAsMember() {
    const coffee = await seedProduct({ name: 'กาแฟ', stockQty: 10, salePrice: 100, costPrice: 40 });
    const water = await seedProduct({ name: 'น้ำเปล่า', stockQty: 10, salePrice: 100, costPrice: 10 });
    const shiftId = await seedOpenShift(people.employeeId, 500);

    const sale = await createPosSale({
      cashierId: people.employeeId,
      shiftId,
      lines: [
        { productId: coffee.id, quantity: 1 },
        { productId: water.id, quantity: 1 },
      ],
      customerId: people.memberId,
      settlement: { cash: 200 },
    });

    const items = await prisma.order_items.findMany({
      where: { order_id: sale.orderId },
      orderBy: { id: 'asc' },
    });

    return { sale, items, shiftId };
  }

  it('takes back this visit’s share of the points, and the rest when the bill closes', async () => {
    const { sale, items } = await sellThreeAsMember();
    const order = await prisma.orders.findUniqueOrThrow({ where: { id: sale.orderId } });
    expect(order.points_earned).toBeGreaterThan(0);

    const first = await refund(sale.orderId, [{ orderItemId: items[0]!.id.toString(), quantity: 1 }], 1);
    const middle = await prisma.users.findUniqueOrThrow({ where: { id: people.memberId } });

    /*
     * Half the bill came back, so about half the points go: they are a reward for
     * money the customer still holds. Asserted as a band rather than an exact
     * figure because the share is a floor of a rounded amount, and the point of the
     * case is that it is proportional, not that it equals a number this test
     * happens to know.
     */
    expect(first.pointsClawedBack).toBeGreaterThan(0);
    expect(first.pointsClawedBack).toBeLessThan(order.points_earned);
    expect(middle.points_balance).toBe(order.points_earned - first.pointsClawedBack);

    const second = await refund(sale.orderId, null, 1);
    const after = await prisma.users.findUniqueOrThrow({ where: { id: people.memberId } });

    expect(first.pointsClawedBack + second.pointsClawedBack).toBe(order.points_earned);
    expect(after.points_balance).toBe(0);
  });

  it('never claws back more than the sale earned, however the visits are split', async () => {
    const { sale, items } = await sellThreeAsMember();
    const order = await prisma.orders.findUniqueOrThrow({ where: { id: sale.orderId } });

    // One line each, and then whatever is left: the rounding lands somewhere, and
    // it must not land on the customer as a negative balance.
    await refund(sale.orderId, [{ orderItemId: items[0]!.id.toString(), quantity: 1 }], 1);
    await refund(sale.orderId, [{ orderItemId: items[1]!.id.toString(), quantity: 1 }], 1);

    const member = await prisma.users.findUniqueOrThrow({ where: { id: people.memberId } });
    expect(member.points_balance).toBe(0);

    const notes = await prisma.credit_notes.findMany({ where: { order_id: sale.orderId } });
    expect(notes).toHaveLength(2);
    expect(notes.reduce((total, note) => total + note.points_clawed_back, 0)).toBe(
      order.points_earned,
    );
  });
});

describe('the guarantees the database keeps', () => {
  it('refuses a note whose lines, discount and total do not reconcile', async () => {
    const { sale } = await sellThree();

    await expect(
      prisma.credit_notes.create({
        data: {
          document_number: 'CN-2026-999999',
          order_id: sale.orderId,
          sequence: 1,
          reason: 'ทดสอบ',
          refund_method: 'cash',
          gross_amount: 100,
          discount_amount: 10,
          final_amount: 95,
          net_amount: 95,
          vat_amount: 0,
          created_by: people.adminId,
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses the same sequence twice on one sale, whatever the application does', async () => {
    const { sale } = await sellThree();

    const row = {
      order_id: sale.orderId,
      sequence: 1,
      reason: 'ทดสอบ',
      refund_method: 'cash' as const,
      gross_amount: 100,
      discount_amount: 0,
      final_amount: 100,
      net_amount: 100,
      vat_amount: 0,
      created_by: people.adminId,
    };

    await prisma.credit_notes.create({ data: { ...row, document_number: 'CN-2026-000101' } });
    await expect(
      prisma.credit_notes.create({ data: { ...row, document_number: 'CN-2026-000102' } }),
    ).rejects.toThrow();
  });

  it('does not burn a credit-note number when a refund is refused', async () => {
    const { sale, items } = await sellThree();

    expect((await readSeries()).creditNote).toBe(0n);

    await refund(sale.orderId, [{ orderItemId: items[0]!.orderItemId, quantity: 1 }], 1);
    expect((await readSeries()).creditNote).toBe(1n);

    await expect(
      refund(sale.orderId, [{ orderItemId: items[0]!.orderItemId, quantity: 1 }], 1),
    ).rejects.toBeInstanceOf(ValidationError);

    // Still one: a refused refund leaves the series exactly where it was.
    expect((await readSeries()).creditNote).toBe(1n);
  });
});
