// Seam under test: settling what the shop owes a consignor (ADR 0023 §6).
//
// Money leaving the shop to somebody outside it is the one place this feature stops
// being bookkeeping. So the properties under test are the ones a mistake would hide:
// a payout can never exceed the balance, cash can never leave without a drawer to
// reconcile against (the same refusal a cash refund makes), the drawer's expected cash
// knows the money left, and the statement a consignor is handed is the ledger's own
// movements — not a second arithmetic that could disagree with them.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { closeShift } from '@/lib/cash-shifts';
import { setConsignment } from '@/lib/consignment';
import { consignorBalance, loadPayoutStatement, payConsignor } from '@/lib/consignment-payout';
import { refundOrder } from '@/lib/credit-notes';
import { ConflictError, ValidationError } from '@/lib/errors';
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

/** A VAT-registered shop and an open drawer. */
async function shopAndShift(): Promise<number> {
  await seedShop({ isVatRegistered: true, vatRate: 7 });
  return seedOpenShift(people.employeeId);
}

/** Sells `quantity` of a ฿107 (฿100 net) consigned product; returns the order id. */
async function sellConsigned(
  shiftId: number,
  productId: string,
  quantity: number,
): Promise<string> {
  const sale = await createPosSale({
    cashierId: people.employeeId,
    shiftId,
    lines: [{ productId, quantity }],
    customerId: null,
    settlement: { cash: 107 * quantity },
  });
  return sale.orderId;
}

function pay(overrides: Partial<Parameters<typeof payConsignor>[1]> = {}) {
  return prisma.$transaction((tx) =>
    payConsignor(tx, {
      consignorUserId: people.memberId,
      amountThb: 40,
      method: 'promptpay',
      shiftId: null,
      actorId: people.adminId,
      ...overrides,
    }),
  );
}

describe('paying a consignor', () => {
  it('nets the balance to zero and writes the ledger debit against the statement', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sellConsigned(shiftId, product.id, 1);
    expect(await consignorBalance(prisma, people.memberId)).toBe(40);

    const result = await pay({ amountThb: 40 });

    expect(result.balanceBeforeThb).toBe(40);
    expect(result.balanceAfterThb).toBe(0);
    expect(await consignorBalance(prisma, people.memberId)).toBe(0);

    const debit = await prisma.consignor_payables.findFirstOrThrow({ where: { kind: 'payout' } });
    expect(Number(debit.amount_thb)).toBe(-40);
    expect(debit.payout_id).not.toBeNull();
    expect(debit.payout_id?.toString()).toBe(result.payoutId);
  });

  it('refuses more than the balance, writing nothing', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sellConsigned(shiftId, product.id, 1);

    await expect(pay({ amountThb: 40.01 })).rejects.toThrow(ValidationError);

    expect(await prisma.consignor_payouts.count()).toBe(0);
    expect(await prisma.consignor_payables.count({ where: { kind: 'payout' } })).toBe(0);
    expect(await consignorBalance(prisma, people.memberId)).toBe(40);
  });

  it('records a partial payout and lets the remainder be settled later', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sellConsigned(shiftId, product.id, 3); // ฿300 net → ฿120 share
    expect(await consignorBalance(prisma, people.memberId)).toBe(120);

    const first = await pay({ amountThb: 50 });
    expect(first.balanceAfterThb).toBe(70);
    expect(await consignorBalance(prisma, people.memberId)).toBe(70);

    const second = await pay({ amountThb: 70 });
    expect(second.balanceAfterThb).toBe(0);
    expect(await consignorBalance(prisma, people.memberId)).toBe(0);
  });
});

describe('how the money leaves', () => {
  it('refuses a cash payout with no open drawer, as a cash refund does', async () => {
    await seedShop({ isVatRegistered: true, vatRate: 7 });
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    // A sale needs a drawer; open one, sell, then close it so the payout has none.
    const shiftId = await seedOpenShift(people.employeeId, 2000);
    await sellConsigned(shiftId, product.id, 1);
    await closeShift({ shiftId, userId: people.employeeId, actualCash: 2107 });

    await expect(pay({ method: 'cash', shiftId })).rejects.toThrow(ConflictError);

    expect(await prisma.consignor_payouts.count()).toBe(0);
    expect(await consignorBalance(prisma, people.memberId)).toBe(40);
  });

  it('allows a transfer with no drawer, because it never touched one', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sellConsigned(shiftId, product.id, 1);

    const result = await pay({ method: 'promptpay', shiftId: null });

    expect(result.shiftId).toBeNull();
    const payout = await prisma.consignor_payouts.findUniqueOrThrow({
      where: { id: BigInt(result.payoutId) },
    });
    expect(payout.shift_id).toBeNull();
  });

  it('counts a cash payout against the drawer, so the close reconciles', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sellConsigned(shiftId, product.id, 1); // ฿107 into the drawer

    await pay({ method: 'cash', shiftId, amountThb: 40 });

    // Initial ฿2000 + ฿107 taken − ฿40 paid out = ฿2067 expected; the cashier counts it
    // and the drawer balances rather than showing a ฿40 shortage.
    const closed = await closeShift({
      shiftId,
      userId: people.employeeId,
      actualCash: 2067,
    });
    expect(closed.cashPayoutsThb).toBe(40);
    expect(closed.expectedCashThb).toBe(2067);
    expect(closed.discrepancyKind).toBe('balanced');
  });
});

describe('the statement', () => {
  it('lists the movements since the previous payout and closes at the ledger’s balance', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 10 });
    await consign(product.id, 40);

    const orderId = await sellConsigned(shiftId, product.id, 2); // ฿80 share
    const item = await prisma.order_items.findFirstOrThrow({
      where: { order_id: orderId },
      select: { id: true },
    });
    await refundOrder({
      orderId,
      actorId: people.employeeId,
      reason: 'คืนหนึ่งชิ้น',
      refundMethod: 'cash',
      shiftId,
      lines: [{ orderItemId: item.id.toString(), quantity: 1 }],
    });
    // ฿80 credited, ฿40 clawed back → ฿40 owed.
    expect(await consignorBalance(prisma, people.memberId)).toBe(40);

    const payout = await pay({ amountThb: 40 });
    const statement = await loadPayoutStatement(payout.payoutId);

    expect(statement).not.toBeNull();
    if (!statement) return;
    expect(statement.amountThb).toBe(40);
    expect(statement.openingBalanceThb).toBe(0);
    expect(statement.balanceAfterThb).toBe(0);
    expect(statement.lines.map((line) => line.kind)).toEqual(['sale', 'refund']);
    const total = statement.lines.reduce((sum, line) => sum + line.amountThb, 0);
    expect(total).toBe(statement.amountThb);
    expect(statement.consignorName).toBe('ลูกค้า');
  });

  it('opens the second statement at the first payout’s balance', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sellConsigned(shiftId, product.id, 1); // ฿40 share
    const first = await pay({ amountThb: 40 });

    await sellConsigned(shiftId, product.id, 1); // another ฿40 share
    const second = await pay({ amountThb: 40 });

    const statement = await loadPayoutStatement(second.payoutId);
    expect(statement?.openingBalanceThb).toBe(0);
    expect(statement?.lines.map((line) => line.kind)).toEqual(['sale']);

    const firstStatement = await loadPayoutStatement(first.payoutId);
    expect(firstStatement?.lines).toHaveLength(1);
  });
});

describe('the audit trail', () => {
  it('records the payout with the method and the balance it moved', async () => {
    const shiftId = await shopAndShift();
    const product = await seedProduct({ salePrice: 107, stockQty: 5 });
    await consign(product.id, 40);
    await sellConsigned(shiftId, product.id, 1);

    await pay({ amountThb: 40, method: 'cash', shiftId });

    const audit = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'consignment_paid' },
    });
    expect(audit.actor_user_id).toBe(people.adminId);
    expect(audit.shift_id).toBe(shiftId);
    expect(audit.detail).toMatchObject({
      method: 'cash',
      amountThb: 40,
      balanceBeforeThb: 40,
      balanceAfterThb: 0,
    });
  });
});
