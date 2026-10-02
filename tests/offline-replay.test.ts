// Seam under test: a device's queued bills reach the shop (ADR 0019 decisions 4 and 5).
//
// Against real PostgreSQL, because every property here is the database's: the unique index
// that makes a retried batch write one order, the day the books file a bill under, the CHECK
// that a tax document adds up, the stock that is allowed to go negative, and the counter that
// must not be rewound past a number somebody printed. This is also the only path in the
// codebase where the *client's* figures are the record, so "the device said so" has to be
// checked where a tampered request cannot talk its way past.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { addBangkokDays, bangkokDateString, bangkokParts } from '@/lib/bangkok-time';
import { allocateReceiptNumber, isSeriesReserved } from '@/lib/shop';
import {
  openNumberBlock,
  type NumberBlockRecord,
} from '@/lib/number-blocks';
import {
  syncOfflineBatch,
  type OfflineBillRequest,
  type OfflineBillTax,
} from '@/lib/offline-sales';
import { dashboardSnapshot } from '@/lib/analytics';
import { buildReport } from '@/lib/reports';
import { formatReceiptNumber } from '@/lib/shop-view';
import { computeVat } from '@/lib/vat';

import {
  prisma,
  resetDatabase,
  seedOpenShift,
  seedPeople,
  seedProduct,
  seedShop,
  type TestPeople,
} from './helpers/test-db';

/*
 * The days come off the shop's own clock, never written down: the replay files a bill under
 * the instant the device reports, and a hardcoded "today" passes on the day it is written and
 * fails at Bangkok midnight — the mistake three `device-numbers` tests already made once.
 */
const TODAY = bangkokDateString(new Date());
const YESTERDAY = addBangkokDays(TODAY, -1);
const TOMORROW = addBangkokDays(TODAY, 1);
const LABEL = 'แท็บเล็ตหน้าเคาน์เตอร์';

let people: TestPeople;

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
  await seedShop({ receiptPrefix: 'FR' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A receipt block for the till, and (optionally) today's call numbers. */
function borrowReceipts(size = 50): Promise<NumberBlockRecord> {
  return openNumberBlock({
    series: 'receipt',
    size,
    deviceLabel: LABEL,
    userId: people.employeeId,
  });
}

function borrowCallNumbers(day = TODAY, size = 100): Promise<NumberBlockRecord> {
  return openNumberBlock({
    series: 'queue',
    day,
    size,
    deviceLabel: LABEL,
    userId: people.employeeId,
  });
}

/** The tax facts a device would have printed for a bill of this amount. */
function taxFor(amountThb: number, isVatRegistered = true): OfflineBillTax {
  const breakdown = computeVat({
    amountThb,
    ratePercent: 7,
    pricesIncludeVat: true,
    isVatRegistered,
  });
  return {
    isVatInvoice: breakdown.isVatInvoice,
    vatRatePercent: breakdown.isVatInvoice ? breakdown.ratePercent : null,
    netThb: breakdown.netThb,
    vatThb: breakdown.vatThb,
  };
}

/** One queued bill, with the defaults a cash sale of one item has. */
function queuedBill(input: {
  productId: string;
  unitPrice: number;
  quantity?: number;
  sequence?: number;
  clientRef?: string;
  soldAt?: Date;
  receivedThb?: number;
  numbers?: OfflineBillRequest['numbers'];
  tax?: OfflineBillTax;
}): OfflineBillRequest {
  const quantity = input.quantity ?? 1;
  const totalThb = input.unitPrice * quantity;
  return {
    clientRef: input.clientRef ?? crypto.randomUUID(),
    sequence: input.sequence ?? 1,
    soldAt: (input.soldAt ?? new Date()).toISOString(),
    soldDay: bangkokDateString(input.soldAt ?? new Date()),
    receivedThb: input.receivedThb ?? totalThb,
    totalThb,
    lines: [{ productId: input.productId, quantity, unitPrice: input.unitPrice }],
    ...(input.numbers ? { numbers: input.numbers } : {}),
    tax: input.tax ?? taxFor(totalThb),
  };
}

function sync(input: {
  shiftId: number;
  bills?: OfflineBillRequest[];
  reports?: { blockId: string; mode: 'report' | 'cancel'; lastUsed?: number }[];
  now?: Date;
}) {
  return syncOfflineBatch({
    cashierId: people.employeeId,
    shiftId: input.shiftId,
    bills: input.bills ?? [],
    reports: input.reports ?? [],
    ...(input.now ? { now: input.now } : {}),
  });
}

describe('replay ownership and identity', () => {
  it('carries a local collected ticket forward after a lost response without a second sale', async () => {
    const block = await borrowReceipts();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ stockQty: 10 });
    const bill = { ...queuedBill({ productId: product.id, unitPrice: 100, numbers: { receipt: { blockId: block.id, value: 1 } } }), fulfilment: 'preparing' as const };
    const first = await sync({ shiftId, bills: [bill] });
    const second = await sync({ shiftId, bills: [{ ...bill, fulfilment: 'collected' }] });
    expect(second.bills[0]?.status).toBe('duplicate');
    expect((await prisma.orders.findUniqueOrThrow({ where: { id: first.bills[0]!.orderId } })).fulfilment).toBe('collected');
    expect(await prisma.payments.count()).toBe(1);
  });

  it('refuses a receipt borrowed by another cashier without moving money or stock', async () => {
    const block = await openNumberBlock({ series: 'receipt', size: 10, deviceLabel: 'other', userId: people.adminId });
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ stockQty: 10 });
    const result = await sync({ shiftId, bills: [queuedBill({ productId: product.id, unitPrice: 100, numbers: { receipt: { blockId: block.id, value: 1 } } })] });
    expect(result.bills[0]?.code).toBe('DEVICE_NUMBER_WRONG_OWNER');
    expect(await prisma.payments.count()).toBe(0);
  });

  it('refuses a VAT replay with no printed invoice number', async () => {
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ stockQty: 10 });
    const result = await sync({ shiftId, bills: [queuedBill({ productId: product.id, unitPrice: 100 })] });
    expect(result.bills[0]?.code).toBe('REPLAY_RECEIPT_REQUIRED');
    expect(await prisma.payments.count()).toBe(0);
  });

  it('refuses reuse of a recorded identity with changed cash or tax', async () => {
    const block = await borrowReceipts();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ stockQty: 10 });
    const bill = queuedBill({ productId: product.id, unitPrice: 100, numbers: { receipt: { blockId: block.id, value: 1 } } });
    expect((await sync({ shiftId, bills: [bill] })).bills[0]?.status).toBe('recorded');
    expect((await sync({ shiftId, bills: [{ ...bill, receivedThb: 200 }] })).bills[0]?.code).toBe('REPLAY_ID_CONFLICT');
    expect((await sync({ shiftId, bills: [{ ...bill, tax: { ...bill.tax, netThb: 100, vatThb: 0 } }] })).bills[0]?.code).toBe('REPLAY_ID_CONFLICT');
    expect((await sync({ shiftId, bills: [{ ...bill, soldAt: new Date(Date.now() - 1000).toISOString() }] })).bills[0]?.code).toBe('REPLAY_ID_CONFLICT');
    expect((await sync({ shiftId, bills: [{ ...bill, numbers: { receipt: { blockId: crypto.randomUUID(), value: 1 } } }] })).bills[0]?.code).toBe('REPLAY_ID_CONFLICT');
    expect(await prisma.payments.count()).toBe(1);
  });

  it('names short cash and an over-limit discount as separate refusals', async () => {
    const block = await borrowReceipts();
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ stockQty: 10 });
    const short = await sync({
      shiftId,
      bills: [queuedBill({ productId: product.id, unitPrice: 100, receivedThb: 50, numbers: { receipt: { blockId: block.id, value: 1 } } })],
    });
    expect(short.bills[0]?.code).toBe('REPLAY_CASH_SHORT');
    /*
     * Lines total 100 but the bill charges 40 — a 60 discount, past the shop's default 50
     * limit. Same shape as `REPLAY_CASH_SHORT` used to share a code with.
     */
    const discounted = queuedBill({ productId: product.id, unitPrice: 100, receivedThb: 40, numbers: { receipt: { blockId: block.id, value: 2 } } });
    const over = await sync({ shiftId, bills: [{ ...discounted, totalThb: 40, tax: taxFor(40) }] });
    expect(over.bills[0]?.code).toBe('REPLAY_DISCOUNT_OVER_LIMIT');
    expect(await prisma.payments.count()).toBe(0);
  });
});

describe('concurrent replay', () => {
  it('records one bill when two requests race', async () => {
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ stockQty: 10 });
    const block = await borrowReceipts();
    const bill = queuedBill({ productId: product.id, unitPrice: 100, numbers: { receipt: { blockId: block.id, value: 1 } } });
    const results = await Promise.all([sync({ shiftId, bills: [bill] }), sync({ shiftId, bills: [bill] })]);
    expect(results.flatMap((result) => result.bills.map((entry) => entry.status)).sort()).toEqual(['duplicate', 'recorded']);
    expect(await prisma.payments.count()).toBe(1);
  });
});

describe('a bill the device closed with no connection', () => {
  it('records the numbers, the price and the cash exactly as they were printed', async () => {
    const receiptBlock = await borrowReceipts();
    const callBlock = await borrowCallNumbers();
    const shiftId = await seedOpenShift(people.employeeId);
    // The catalogue's price is deliberately *not* what the device charged, so the test can
    // tell "the slip's price" from "the catalogue's price".
    const product = await seedProduct({ salePrice: 100, costPrice: 60, stockQty: 10 });
    const soldAt = new Date();

    const result = await sync({
      shiftId,
      bills: [
        queuedBill({
          productId: product.id,
          unitPrice: 80,
          receivedThb: 100,
          soldAt,
          numbers: {
            receipt: { blockId: receiptBlock.id, value: 1 },
            call: { blockId: callBlock.id, value: 7 },
          },
        }),
      ],
    });

    expect(result.bills).toHaveLength(1);
    expect(result.bills[0]?.status).toBe('recorded');

    const order = await prisma.orders.findFirstOrThrow({
      include: { items: true, payments: true },
    });
    expect(order.client_ref).not.toBeNull();
    // The device's instant, not the moment the server heard about it.
    expect(order.sold_at.toISOString()).toBe(soldAt.toISOString());
    expect(order.completed_at?.toISOString()).toBe(soldAt.toISOString());
    // The printed document's number, taken from the loan — not allocated.
    expect(order.receipt_number).toBe(
      formatReceiptNumber('FR', bangkokParts(soldAt).year, 1),
    );
    expect(order.queue_number).toBe(7);
    expect(order.queue_day?.toISOString()).toBe(`${TODAY}T00:00:00.000Z`);
    expect(Number(order.final_amount)).toBe(80);

    // The slip's price is the record; the catalogue's is only compared against it.
    expect(Number(order.items[0]?.unit_price)).toBe(80);
    expect(Number(order.items[0]?.total_price)).toBe(80);

    // One cash leg, with the notes handed over — which is what the drawer counts.
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0]?.method).toBe('cash');
    expect(Number(order.payments[0]?.amount)).toBe(80);
    expect(Number(order.payments[0]?.received_amount)).toBe(100);
    expect(Number(order.payments[0]?.change_amount)).toBe(20);

    // The goods leave the shelf, and the trail says how the bill arrived.
    const stock = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(stock.stock_qty).toBe(9);

    const audit = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'offline_sale_synced' },
    });
    expect(audit.target_id).toBe(order.id);
    expect(audit.shift_id).toBe(shiftId);
  });

  it('carries the price disagreement into the audit trail', async () => {
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });

    const block = await borrowReceipts();
    await sync({ shiftId, bills: [queuedBill({ productId: product.id, unitPrice: 80, numbers: { receipt: { blockId: block.id, value: 1 } } })] });

    const audit = await prisma.audit_logs.findFirstOrThrow({
      where: { action: 'offline_sale_synced' },
    });
    const detail = audit.detail as { priceDisagreements?: unknown[] } | null;
    expect(detail?.priceDisagreements).toHaveLength(1);
  });

  it('answers a retried bill with the order that is already there, and writes one', async () => {
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });
    const block = await borrowReceipts();
    const bill = queuedBill({ productId: product.id, unitPrice: 100, numbers: { receipt: { blockId: block.id, value: 1 } } });

    const first = await sync({ shiftId, bills: [bill] });
    const second = await sync({ shiftId, bills: [bill] });

    expect(first.bills[0]?.status).toBe('recorded');
    expect(second.bills[0]?.status).toBe('duplicate');
    expect(second.bills[0]?.orderId).toBe(first.bills[0]?.orderId);

    // One order, one stock movement, one cash leg: the double-charge guard, measured.
    expect(await prisma.orders.count()).toBe(1);
    expect(await prisma.payments.count()).toBe(1);
    const stock = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(stock.stock_qty).toBe(9);
  });

  it('stops the batch at a refusal and leaves the bills after it untouched', async () => {
    const receiptBlock = await borrowReceipts(50);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 20 });

    const result = await sync({
      shiftId,
      bills: [
        queuedBill({
          productId: product.id,
          unitPrice: 100,
          sequence: 1,
          numbers: { receipt: { blockId: receiptBlock.id, value: 1 } },
        }),
        queuedBill({
          productId: product.id,
          unitPrice: 100,
          sequence: 2,
          // Outside the 1..50 that was lent: a number nobody gave this device.
          numbers: { receipt: { blockId: receiptBlock.id, value: 99 } },
        }),
        queuedBill({ productId: product.id, unitPrice: 100, sequence: 3 }),
      ],
    });

    expect(result.bills.map((entry) => entry.status)).toEqual(['recorded', 'refused']);
    expect(result.bills[1]?.code).toBe('DEVICE_NUMBER_OUT_OF_RANGE');
    // The third bill was never tried: stepping over a refused number would put a hole in the
    // series, which is the one thing the whole protocol exists to prevent.
    expect(result.notAttempted).toBe(1);
    expect(await prisma.orders.count()).toBe(1);
    // And the loan did not move for the refused number.
    const block = await prisma.number_blocks.findUniqueOrThrow({ where: { id: receiptBlock.id } });
    expect(block.last_used_number).toBe(1);
  });
});

describe('the day a replayed bill belongs to', () => {
  it('files a bill sold yesterday under yesterday, not under this morning', async () => {
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });
    // 21:00 yesterday in Bangkok.
    const soldAt = new Date(`${YESTERDAY}T14:00:00.000Z`);

    const block = await borrowReceipts();
    await sync({ shiftId, bills: [queuedBill({ productId: product.id, unitPrice: 100, soldAt, numbers: { receipt: { blockId: block.id, value: 1 } } })] });

    const order = await prisma.orders.findFirstOrThrow();
    expect(bangkokDateString(order.sold_at)).toBe(YESTERDAY);
    // The server's own clock never says otherwise: it learned about the bill just now.
    expect(bangkokDateString(order.created_at)).toBe(TODAY);

    const yesterday = await buildReport({ type: 'sales_summary', from: YESTERDAY, to: YESTERDAY });
    const today = await buildReport({ type: 'sales_summary', from: TODAY, to: TODAY });

    expect(yesterday.rows.map((row) => row[0])).toContain(order.order_number);
    expect(today.rows.map((row) => row[0])).not.toContain(order.order_number);
  });

  it('keeps a sale out of the future and says that it did', async () => {
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });
    const now = new Date();
    const block = await borrowReceipts();

    const result = await sync({
      shiftId,
      now,
      bills: [
        queuedBill({
          productId: product.id,
          unitPrice: 100,
          numbers: { receipt: { blockId: block.id, value: 1 } },
          // A device clock running an hour ahead.
          soldAt: new Date(now.getTime() + 60 * 60 * 1000),
        }),
      ],
    });

    expect(result.bills[0]?.status).toBe('recorded');
    expect(result.bills[0]?.clamped).toBe(true);
    expect(result.bills[0]?.soldAt).toBe(now.toISOString());

    // The dashboard's own day is the one it landed in.
    const snapshot = await dashboardSnapshot(now);
    expect(snapshot.today.orderCount).toBe(1);
  });
});

describe('stock that was not there', () => {
  it('accepts the bill, lets stock go negative and raises the task', async () => {
    const shiftId = await seedOpenShift(people.employeeId);
    // One on the shelf; three sold offline from a snapshot that said otherwise.
    const product = await seedProduct({ salePrice: 100, stockQty: 1 });
    const block = await borrowReceipts();

    const result = await sync({
      shiftId,
      bills: [queuedBill({ productId: product.id, unitPrice: 100, quantity: 3, numbers: { receipt: { blockId: block.id, value: 1 } } })],
    });

    expect(result.bills[0]?.status).toBe('recorded');
    expect(result.bills[0]?.warnings.join(' ')).toContain('ติดลบ');

    const stock = await prisma.products.findUniqueOrThrow({ where: { id: product.id } });
    expect(stock.stock_qty).toBe(-2);

    // The task a manager actually sees, and it disappears when the count is corrected.
    const snapshot = await dashboardSnapshot();
    expect(snapshot.stockShortages.map((row) => row.id)).toContain(product.id);
    expect(snapshot.stockShortages[0]?.stockQty).toBe(-2);
  });
});

describe('the loans a device hands back', () => {
  it('closes the block at the last number printed, and the series resumes with no gap', async () => {
    const receiptBlock = await borrowReceipts(50);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 20 });

    const bills = [1, 2, 3].map((value) =>
      queuedBill({
        productId: product.id,
        unitPrice: 100,
        sequence: value,
        numbers: { receipt: { blockId: receiptBlock.id, value } },
      }),
    );

    expect(await isSeriesReserved(prisma, 'receipt')).toBe(true);

    const result = await sync({
      shiftId,
      bills,
      reports: [{ blockId: receiptBlock.id, mode: 'report', lastUsed: 3 }],
    });

    expect(result.reports[0]?.status).toBe('reported');
    expect(result.reports[0]?.lastUsed).toBe(3);

    const shop = await prisma.shops.findUniqueOrThrow({
      where: { id: 1 },
      select: { receipt_running_number: true },
    });
    // Not 50: the tail comes back, so the next bill the shop issues is 4 — the number after
    // the last one actually printed.
    expect(Number(shop.receipt_running_number)).toBe(3);
    expect(await isSeriesReserved(prisma, 'receipt')).toBe(false);

    const next = await allocateReceiptNumber(prisma, new Date());
    expect(next?.receiptNumber).toMatch(/-000004$/);
  });

  it('refuses to count past the bills that arrived, so the counter cannot pass a hole', async () => {
    const receiptBlock = await borrowReceipts(50);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 20 });

    const result = await sync({
      shiftId,
      bills: [
        queuedBill({
          productId: product.id,
          unitPrice: 100,
          numbers: { receipt: { blockId: receiptBlock.id, value: 1 } },
        }),
      ],
      // The device thinks it printed five; only the first bill reached the shop.
      reports: [{ blockId: receiptBlock.id, mode: 'report', lastUsed: 5 }],
    });
    expect(result.bills[0]?.status).toBe('recorded');
    expect(result.reports[0]?.code).toBe('REPLAY_REPORT_AHEAD_OF_BILLS');

    const block = await prisma.number_blocks.findUniqueOrThrow({ where: { id: receiptBlock.id } });
    expect(block.reported_at).toBeNull();
    expect(await isSeriesReserved(prisma, 'receipt')).toBe(true);
  });

  it('answers a second report of the same block as already closed', async () => {
    const receiptBlock = await borrowReceipts(50);
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 20 });

    const report = { blockId: receiptBlock.id, mode: 'report' as const, lastUsed: 1 };
    await sync({
      shiftId,
      bills: [
        queuedBill({
          productId: product.id,
          unitPrice: 100,
          numbers: { receipt: { blockId: receiptBlock.id, value: 1 } },
        }),
      ],
      reports: [report],
    });
    const again = await sync({ shiftId, reports: [report] });

    expect(again.reports[0]?.status).toBe('already_closed');
    expect(again.reports[0]?.lastUsed).toBe(1);
  });
});

describe('what the drawer had already done', () => {
  it('records a bill whose drawer was closed, and says the count is short', async () => {
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });
    await prisma.cash_shifts.update({
      where: { id: shiftId },
      data: { status: 'closed', closed_at: new Date(), actual_cash: 2000, expected_cash: 2000 },
    });

    const block = await borrowReceipts();
    const result = await sync({
      shiftId,
      bills: [queuedBill({ productId: product.id, unitPrice: 100, numbers: { receipt: { blockId: block.id, value: 1 } } })],
    });

    // Recorded, not refused: the money was taken before the drawer was counted, and a bill
    // the shop cannot file leaves it holding cash with no record of it.
    expect(result.bills[0]?.status).toBe('recorded');
    expect(result.bills[0]?.warnings.join(' ')).toContain('ปิดไปแล้ว');
    expect(await prisma.orders.count()).toBe(1);
  });
});

describe('a shop that has borrowed nothing', () => {
  it('records a device bill with no receipt number, exactly as the slip printed it', async () => {
    // The other side of the VAT decision: a shop that issues no tax invoice, and a device
    // holding nothing at all. Nothing may be allocated for a document that does not exist.
    await resetDatabase();
    people = await seedPeople();
    await seedShop({ isVatRegistered: false, receiptPrefix: 'FR' });
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });

    const result = await sync({
      shiftId,
      bills: [queuedBill({ productId: product.id, unitPrice: 100, tax: taxFor(100, false) })],
    });

    expect(result.bills[0]?.status).toBe('recorded');
    const order = await prisma.orders.findFirstOrThrow();
    expect(order.receipt_number).toBeNull();
    expect(order.queue_number).toBeNull();
    expect(order.is_vat_invoice).toBe(false);
    // And no number was consumed from the shop's series.
    const shop = await prisma.shops.findUniqueOrThrow({
      where: { id: 1 },
      select: { receipt_running_number: true },
    });
    expect(Number(shop.receipt_running_number)).toBe(0);
  });

  it('refuses a bill whose tax settings no longer match the slip', async () => {
    // The shop turned VAT registration on during the outage. The device printed no invoice,
    // and the shop now requires one — a document that was never printed must not be created
    // after the fact, so this is a refusal for a person rather than a silent re-issue.
    const shiftId = await seedOpenShift(people.employeeId);
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });

    const result = await sync({
      shiftId,
      bills: [queuedBill({ productId: product.id, unitPrice: 100, tax: taxFor(100, false) })],
    });

    expect(result.bills[0]?.status).toBe('refused');
    expect(result.bills[0]?.code).toBe('REPLAY_TAX_SETTINGS_CHANGED');
    expect(await prisma.orders.count()).toBe(0);
  });
});

describe('a device whose drawer is not the one it thinks', () => {
  it('refuses the whole request rather than writing cash against a drawer that is gone', async () => {
    const product = await seedProduct({ salePrice: 100, stockQty: 10 });

    await expect(
      sync({ shiftId: 9999, bills: [queuedBill({ productId: product.id, unitPrice: 100 })] }),
    ).rejects.toMatchObject({ code: 'REPLAY_SHIFT_UNKNOWN' });
    expect(await prisma.orders.count()).toBe(0);
  });
});
