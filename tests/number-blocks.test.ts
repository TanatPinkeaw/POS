// Seam under test: lending the shop's numbers to a device, and the freeze that keeps a
// series gapless (ADR 0019).
//
// Against real PostgreSQL, because every property here *is* a database property: the
// counter and the loan row moving inside one transaction, the partial unique index
// refusing a second loan of one range, and the freeze travelling inside the statement
// that allocates rather than beside it. A double would agree with whatever this file
// claimed.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma, resetDatabase, seedPeople, seedShop, type TestPeople } from './helpers/test-db';
import { ConflictError, SeriesReservedError, ValidationError } from '@/lib/errors';
import {
  cancelNumberBlock,
  loadOpenNumberBlocks,
  openNumberBlock,
  reportNumberBlock,
  type NumberBlockRecord,
} from '@/lib/number-blocks';
import { allocateQueueNumber, allocateReceiptNumber, isSeriesReserved } from '@/lib/shop';

let people: TestPeople;

/** 12:00 in Bangkok, so the day these tests name is not a near-midnight coin toss. */
const MIDDAY = (day: string) => new Date(`${day}T05:00:00.000Z`);

const TODAY = '2026-09-29';
const TOMORROW = '2026-09-30';
const LABEL = 'แท็บเล็ตหน้าเคาน์เตอร์';

beforeEach(async () => {
  await resetDatabase();
  people = await seedPeople();
  await seedShop({ receiptPrefix: 'FR' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function borrowReceipts(size = 50): Promise<NumberBlockRecord> {
  return openNumberBlock({ series: 'receipt', size, deviceLabel: LABEL, userId: people.employeeId });
}

function borrowCallNumbers(day: string, size = 100): Promise<NumberBlockRecord> {
  return openNumberBlock({
    series: 'queue',
    day,
    size,
    deviceLabel: LABEL,
    userId: people.employeeId,
  });
}

/** The running number inside a formatted receipt number: `FR-2026-000013` → 13. */
function running(formatted: string): number {
  return Number(formatted.slice(-6));
}

/** The shop's counters, read raw — where the series actually stands. */
async function counters(): Promise<{ receipt: number; queue: number; queueDay: string | null }> {
  const rows = await prisma.$queryRaw<
    { receipt: bigint; queue: number; day: Date | null }[]
  >`
    SELECT "receipt_running_number" AS receipt,
           "queue_running_number"  AS queue,
           "queue_running_day"     AS day
      FROM "shops" WHERE "id" = 1
  `;
  const row = rows[0]!;
  return {
    receipt: Number(row.receipt),
    queue: row.queue,
    queueDay: row.day === null ? null : row.day.toISOString().slice(0, 10),
  };
}

describe('borrowing a range', () => {
  it('moves the shop’s counter to the end of it, and records who asked', async () => {
    const block = await borrowReceipts();

    expect(block).toMatchObject({
      kind: 'receipt',
      day: null,
      from: 1,
      to: 50,
      lastUsed: null,
      deviceLabel: LABEL,
    });
    expect((await counters()).receipt).toBe(50);
  });

  it('refuses a second loan of one series, because two ranges cannot share numbers', async () => {
    await borrowReceipts();

    await expect(borrowReceipts()).rejects.toMatchObject({
      code: 'NUMBER_BLOCK_ALREADY_OPEN',
    });
    // And the refusal burned nothing: the counter is still where the first loan left it.
    expect((await counters()).receipt).toBe(50);
  });

  it('starts each day’s call numbers again at one', async () => {
    const today = await borrowCallNumbers(TODAY);
    const tomorrow = await borrowCallNumbers(TOMORROW);

    expect(today).toMatchObject({ kind: 'queue', day: TODAY, from: 1, to: 100 });
    expect(tomorrow).toMatchObject({ kind: 'queue', day: TOMORROW, from: 1, to: 100 });
  });

  it('refuses a second loan for one day', async () => {
    await borrowCallNumbers(TODAY);

    await expect(borrowCallNumbers(TODAY)).rejects.toMatchObject({
      code: 'NUMBER_BLOCK_ALREADY_OPEN',
    });
  });

  it('refuses a loan that could not be honoured', async () => {
    await expect(borrowReceipts(0)).rejects.toBeInstanceOf(ValidationError);
    await expect(borrowReceipts(2_001)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      openNumberBlock({
        series: 'receipt',
        day: TODAY,
        size: 10,
        deviceLabel: LABEL,
        userId: people.employeeId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      openNumberBlock({
        series: 'queue',
        day: null,
        size: 10,
        deviceLabel: LABEL,
        userId: people.employeeId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      openNumberBlock({
        series: 'receipt',
        size: 10,
        deviceLabel: '   ',
        userId: people.employeeId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // A refused borrow leaves nothing behind: no row, and the counter untouched.
    expect((await counters()).receipt).toBe(0);
  });
});

describe('the freeze', () => {
  it('refuses a tax invoice while a device is holding the receipts', async () => {
    await borrowReceipts();

    await expect(allocateReceiptNumber(prisma, MIDDAY(TODAY))).rejects.toBeInstanceOf(
      SeriesReservedError,
    );
    expect(await isSeriesReserved(prisma, 'receipt')).toBe(true);
  });

  it('continues the series from the last number printed, with no gap', async () => {
    const block = await borrowReceipts();
    // The till prints 1..12 with no connection and reports where it stopped.
    await reportNumberBlock({ id: block.id, lastUsed: 12, userId: people.employeeId });

    expect((await counters()).receipt).toBe(12);
    expect(await isSeriesReserved(prisma, 'receipt')).toBe(false);

    const allocation = await allocateReceiptNumber(prisma, MIDDAY(TODAY));
    expect(allocation).not.toBeNull();
    expect(running(allocation!.receiptNumber)).toBe(13);
  });

  it('hands back a range nobody printed from', async () => {
    const block = await borrowReceipts();
    await cancelNumberBlock({ id: block.id, userId: people.employeeId });

    expect((await counters()).receipt).toBe(0);
    const allocation = await allocateReceiptNumber(prisma, MIDDAY(TODAY));
    expect(running(allocation!.receiptNumber)).toBe(1);
  });

  it('holds only the day it was borrowed for', async () => {
    await borrowCallNumbers(TOMORROW);

    // Tomorrow's loan says nothing about today's counter, which is a different series.
    const today = await allocateQueueNumber(prisma, MIDDAY(TODAY));
    expect(today?.value).toBe(1);

    await borrowCallNumbers(TODAY);
    expect(await allocateQueueNumber(prisma, MIDDAY(TODAY))).toBeNull();
  });

  it('rewinds a call-number day still in progress', async () => {
    const block = await borrowCallNumbers(TODAY);
    await reportNumberBlock({ id: block.id, lastUsed: 7, userId: people.employeeId });

    expect(await counters()).toMatchObject({ queue: 7, queueDay: TODAY });
    const next = await allocateQueueNumber(prisma, MIDDAY(TODAY));
    expect(next?.value).toBe(8);
  });
});

describe('closing a block', () => {
  it('refuses a number outside the range it borrowed', async () => {
    const block = await borrowReceipts(10);

    await expect(
      reportNumberBlock({ id: block.id, lastUsed: 11, userId: people.employeeId }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      reportNumberBlock({ id: block.id, lastUsed: 0, userId: people.employeeId }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a report that would move the usage backwards', async () => {
    const block = await borrowReceipts();
    /*
     * The only writer of `last_used_number` before a report is the sale path itself — a
     * till that holds a block and is online sends its own number (phase 3 of the spec).
     * The raw write stands in for it, so that the invariant is pinned today rather than
     * discovered by the next round.
     */
    await prisma.$executeRaw`
      UPDATE "number_blocks" SET "last_used_number" = 12 WHERE "id" = ${block.id}::uuid
    `;

    await expect(
      reportNumberBlock({ id: block.id, lastUsed: 5, userId: people.employeeId }),
    ).rejects.toMatchObject({ code: 'NUMBER_BLOCK_USAGE_REGRESSED' });
  });

  it('refuses a second report of the same block, which is a device sending twice', async () => {
    const block = await borrowReceipts();
    await reportNumberBlock({ id: block.id, lastUsed: 3, userId: people.employeeId });

    await expect(
      reportNumberBlock({ id: block.id, lastUsed: 4, userId: people.employeeId }),
    ).rejects.toMatchObject({ code: 'NUMBER_BLOCK_NOT_OPEN' });
    await expect(
      cancelNumberBlock({ id: block.id, userId: people.employeeId }),
    ).rejects.toMatchObject({ code: 'NUMBER_BLOCK_NOT_OPEN' });
  });

  it('refuses to cancel a block whose numbers are already on paper', async () => {
    const block = await borrowReceipts();
    await prisma.$executeRaw`
      UPDATE "number_blocks" SET "last_used_number" = 4 WHERE "id" = ${block.id}::uuid
    `;

    await expect(cancelNumberBlock({ id: block.id, userId: people.employeeId })).rejects.toMatchObject(
      { code: 'NUMBER_BLOCK_ALREADY_USED' },
    );
  });

  it('records who closed it — the device, or the admin who resolved it', async () => {
    const device = await borrowReceipts();
    const reported = await reportNumberBlock({
      id: device.id,
      lastUsed: 3,
      userId: people.employeeId,
    });
    expect(reported).toMatchObject({ lastUsed: 3, closedBy: people.employeeId });
    expect(reported.reportedAt).not.toBeNull();

    const stale = await borrowReceipts();
    const cancelled = await cancelNumberBlock({ id: stale.id, userId: people.adminId });
    expect(cancelled).toMatchObject({ cancelledAt: expect.any(Date), closedBy: people.adminId });
  });

  it('says a block that does not exist is not found, rather than blaming the caller', async () => {
    await expect(
      reportNumberBlock({
        id: '00000000-0000-4000-8000-000000000000',
        lastUsed: 1,
        userId: people.employeeId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('what is open, for the screen that resolves it', () => {
  it('lists the loans nobody has reported yet, oldest first', async () => {
    await borrowCallNumbers(TODAY);
    const receipts = await borrowReceipts();
    await borrowCallNumbers(TOMORROW);

    const open = await loadOpenNumberBlocks();
    expect(open.map((block) => block.kind)).toEqual(['receipt', 'queue', 'queue']);
    expect(open).toHaveLength(3);

    await reportNumberBlock({ id: receipts.id, lastUsed: 2, userId: people.employeeId });
    const after = await loadOpenNumberBlocks();
    expect(after.map((block) => block.id)).not.toContain(receipts.id);
    expect(after).toHaveLength(2);
  });
});

describe('the states the database refuses on its own', () => {
  it('refuses a second open block of one series, behind the module’s back', async () => {
    await borrowReceipts();

    await expect(
      prisma.$executeRaw`
        INSERT INTO "number_blocks"
          ("series", "day", "from_number", "to_number", "device_label", "opened_by")
        VALUES ('receipt', NULL, 51, 60, 'เครื่องที่สอง', ${people.adminId}::uuid)
      `,
    ).rejects.toThrow();
  });

  it('refuses a last-used number outside the block’s own range', async () => {
    const block = await borrowReceipts(10);

    await expect(
      prisma.$executeRaw`
        UPDATE "number_blocks" SET "last_used_number" = 99 WHERE "id" = ${block.id}::uuid
      `,
    ).rejects.toThrow();
  });

  it('refuses a block that is both reported and cancelled, or cancelled after use', async () => {
    const block = await borrowReceipts();

    await expect(
      prisma.$executeRaw`
        UPDATE "number_blocks"
           SET "reported_at" = NOW(), "cancelled_at" = NOW()
         WHERE "id" = ${block.id}::uuid
      `,
    ).rejects.toThrow();

    await expect(
      prisma.$executeRaw`
        UPDATE "number_blocks"
           SET "last_used_number" = 1, "cancelled_at" = NOW()
         WHERE "id" = ${block.id}::uuid
      `,
    ).rejects.toThrow();
  });

  it('refuses a call-number block with no day, because the day is what it is for', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO "number_blocks"
          ("series", "day", "from_number", "to_number", "device_label", "opened_by")
        VALUES ('queue', NULL, 1, 10, 'แท็บเล็ต', ${people.employeeId}::uuid)
      `,
    ).rejects.toThrow();
  });
});
