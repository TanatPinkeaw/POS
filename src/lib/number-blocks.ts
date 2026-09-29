/**
 * The shop's side of a number loan — ADR 0019.
 *
 * The pure half (what a block is, what comes next, what a report gives back) is
 * `number-block.ts`. This is the half that touches rows: borrowing a range, which moves
 * the shop's counter forward; reporting how far a device got, which moves it back;
 * cancelling a loan nobody used; and listing what is open, for the screen that resolves
 * a device that never came back.
 *
 * One property is why every function here is a transaction rather than a sequence of
 * statements: **the counter and the block must move together.** A borrow that advanced
 * the counter without writing the row would be a range nobody owns and nobody may
 * issue; a report that closed the row without giving the unused tail back would put a
 * hole in the series that the whole protocol exists to prevent. Neither is left for a
 * caller to remember.
 *
 * What this module does *not* decide: whether a series may allocate at all. That is the
 * freeze inside `allocateReceiptNumber` / `allocateQueueNumber`, which asks these rows
 * in the same statement that allocates, using the same partial indexes the borrow uses.
 */
import { dateColumnFromDay, dayFromDateColumn, isValidCalendarDay } from './bangkok-time';
import { prisma } from './db';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import type { Db } from './inventory';
import { MAX_BLOCK_SIZE, type NumberBlock, type NumberKind } from './number-block';
import { SHOP_ROW_ID } from './shop';

/** A block as the database holds it, plus the rows' own facts. */
export interface NumberBlockRecord extends NumberBlock {
  readonly id: string;
  readonly deviceLabel: string;
  readonly openedAt: Date;
  readonly reportedAt: Date | null;
  readonly cancelledAt: Date | null;
  /** Who closed it — the reporting device, or the admin who resolved a loose end. */
  readonly closedBy: string | null;
}

interface NumberBlockRow {
  id: string;
  series: NumberKind;
  day: Date | null;
  from_number: number;
  to_number: number;
  last_used_number: number | null;
  device_label: string;
  opened_at: Date;
  reported_at: Date | null;
  cancelled_at: Date | null;
  closed_by: string | null;
}

/**
 * Whether a write was refused because something of that shape already exists.
 *
 * Read without importing Prisma's error classes, the way `shop.ts` does it. Two codes
 * rather than one because the borrow checks two different indexes: a unique constraint
 * Prisma knows about reports `P2002`, and a partial one — which Prisma cannot express and
 * therefore reports as a generic raw-query failure — has to be judged by what the
 * database said. Both mean the same thing to a device: *somebody already holds this*.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; meta?: { code?: string; message?: string } };
  if (candidate.code === 'P2002') {
    return true;
  }
  if (candidate.code === 'P2010') {
    const meta = candidate.meta;
    return (
      meta?.code === '23505' || (typeof meta?.message === 'string' && meta.message.includes('23505'))
    );
  }
  return false;
}

function toRecord(row: NumberBlockRow): NumberBlockRecord {
  return {
    id: row.id,
    // The column is `series`; the pure module's word for it is `kind`, and the two are
    // mapped here so `number-block.ts` never has to know how the table spells it.
    kind: row.series,
    // A `DATE` comes back as a `Date` at midnight UTC; `YYYY-MM-DD` is what every other
    // module compares days with, so the conversion happens at this one boundary.
    day: row.day === null ? null : dayFromDateColumn(row.day),
    from: row.from_number,
    to: row.to_number,
    lastUsed: row.last_used_number,
    deviceLabel: row.device_label,
    openedAt: row.opened_at,
    reportedAt: row.reported_at,
    cancelledAt: row.cancelled_at,
    closedBy: row.closed_by,
  };
}

function assertBorrowable(input: {
  series: NumberKind;
  day: string | null;
  size: number;
  deviceLabel: string;
}): void {
  if (!Number.isInteger(input.size) || input.size < 1 || input.size > MAX_BLOCK_SIZE) {
    throw new ValidationError(
      `A number block holds between 1 and ${MAX_BLOCK_SIZE} numbers; got ${input.size}`,
    );
  }
  const label = input.deviceLabel.trim();
  if (label.length === 0 || label.length > 60) {
    throw new ValidationError('A number block needs a device label of 1 to 60 characters');
  }
  // The day is the call-number series' whole reason for existing; on the receipt series
  // it would be a field an admin reads and nobody can explain.
  if (input.series === 'queue' && (input.day === null || !isValidCalendarDay(input.day))) {
    throw new ValidationError('A call-number block must name a calendar day');
  }
  if (input.series === 'receipt' && input.day !== null) {
    throw new ValidationError('The receipt series is numbered per year, not per day');
  }
}

/**
 * Borrows a range from one of the shop's series.
 *
 * The counter is advanced by a single `UPDATE … RETURNING`, so two devices asking at the
 * same instant cannot be handed the same numbers: the second one's statement starts from
 * the row the first one already moved. The day matters for the call numbers — a borrow
 * for a *new* day restarts that day's count at 1, which is what keeps a customer's number
 * short (ADR 0017) instead of growing all week.
 *
 * Refused, by the partial unique index rather than by a check here, when a block of that
 * series (that day, for call numbers) is already open: two loans of one range is two
 * customers called by the same number, arriving through a door the order's own unique
 * index cannot see.
 */
export async function openNumberBlock(input: {
  series: NumberKind;
  day?: string | null;
  size: number;
  deviceLabel: string;
  userId: string;
}): Promise<NumberBlockRecord> {
  const day = input.day ?? null;
  assertBorrowable({ series: input.series, day, size: input.size, deviceLabel: input.deviceLabel });

  try {
    return await prisma.$transaction(async (tx) => {
      const bumped =
        input.series === 'receipt'
          ? await tx.$queryRaw<{ to_number: number }[]>`
              UPDATE "shops"
                 SET "receipt_running_number" = "receipt_running_number" + ${input.size}
               WHERE "id" = ${SHOP_ROW_ID}
              RETURNING "receipt_running_number"::int AS "to_number"
            `
          : await tx.$queryRaw<{ to_number: number }[]>`
              UPDATE "shops"
                 SET "queue_running_number" = CASE
                       WHEN "queue_running_day" = ${day}::date THEN "queue_running_number" + ${input.size}
                       ELSE ${input.size}
                     END,
                     "queue_running_day" = ${day}::date
               WHERE "id" = ${SHOP_ROW_ID}
              RETURNING "queue_running_number" AS "to_number"
            `;

      const to = bumped[0]?.to_number;
      if (to === undefined) {
        throw new NotFoundError('Shop');
      }

      /*
       * The typed client rather than raw SQL, and not for tidiness: a `$queryRaw` insert
       * reports a rejected row as a generic "raw query failed", while the unique-violation
       * mapping is what tells a device "somebody already holds this range" from "the
       * database is unhappy". The partial index is not in the Prisma schema (it cannot
       * be), so the detection below reads the code rather than a constraint name.
       */
      const row = await tx.number_blocks.create({
        data: {
          series: input.series,
          day: day === null ? null : dateColumnFromDay(day),
          from_number: to - input.size + 1,
          to_number: to,
          device_label: input.deviceLabel.trim(),
          opened_by: input.userId,
        },
      });

      return toRecord(row as unknown as NumberBlockRow);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        input.series === 'receipt'
          ? 'เลขใบกำกับภาษีชุดก่อนยังไม่ได้รายงาน — ปิดชุดเดิมก่อนจึงจะยืมชุดใหม่ได้'
          : 'เลขคิวของวันนี้ถูกยืมไปแล้ว — ต้องรายงานชุดเดิมก่อน',
        'NUMBER_BLOCK_ALREADY_OPEN',
      );
    }
    throw error;
  }
}

/**
 * Gives the unused tail of a block back, and closes it.
 *
 * `lastUsed` is the last number the device actually printed, and the shop's counter is
 * set to exactly that — not to the end of the range. This is the function that makes a
 * browser able to issue a gapless series, and the guard below is why it is safe: the
 * counter must still be where *this* block left it, which the freeze guarantees, since
 * nothing else may allocate while the block is open.
 *
 * A call-number block whose day has passed is closed without touching the counter: the
 * shop's counter has already moved to a later day, and yesterday's unused numbers are
 * not reusable — which costs nothing, because a call number is not a tax document.
 */
export async function reportNumberBlock(input: {
  id: string;
  lastUsed: number;
  userId: string;
}): Promise<NumberBlockRecord> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<NumberBlockRow[]>`
      SELECT * FROM "number_blocks" WHERE "id" = ${input.id}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundError('Number block');
    }
    assertOpen(row);

    if (
      !Number.isInteger(input.lastUsed) ||
      input.lastUsed < row.from_number ||
      input.lastUsed > row.to_number
    ) {
      throw new ValidationError(
        `Reported number ${input.lastUsed} is outside the borrowed range ` +
          `${row.from_number}..${row.to_number}`,
      );
    }
    if (row.last_used_number !== null && input.lastUsed < row.last_used_number) {
      throw new ConflictError(
        `ใช้เลขถอยหลังจาก ${row.last_used_number} เป็น ${input.lastUsed} ไม่ได้`,
        'NUMBER_BLOCK_USAGE_REGRESSED',
      );
    }

    /*
     * No check here that an *earlier* block of the same range has been reported first,
     * and the absence is deliberate: the partial unique indexes make that state
     * impossible — one open block per series, and one per day for call numbers — so a
     * guard would be code no test could reach. What protects the counter instead is the
     * guard inside `rewindCounter` (`… = to_number`), which is reachable and does the
     * job the ordering rule was for: nothing rewind past a number somebody else issued.
     */
    await tx.$executeRaw`
      UPDATE "number_blocks"
         SET "last_used_number" = ${input.lastUsed},
             "reported_at" = NOW(),
             "closed_by" = ${input.userId}::uuid
       WHERE "id" = ${row.id}::uuid
    `;
    await rewindCounter(tx, row, input.lastUsed);

    return toRecord({
      ...row,
      last_used_number: input.lastUsed,
      reported_at: new Date(),
      closed_by: input.userId,
    });
  });
}

/**
 * Gives a whole block back, for one nobody printed from.
 *
 * A block that *was* used is reported instead, and the CHECK constraint in the migration
 * says so: cancelling numbers that are already on paper is how a series acquires holes
 * that nobody can explain. The counter goes back to `from − 1`, so the numbers reappear
 * as the next ones issued.
 */
export async function cancelNumberBlock(input: {
  id: string;
  userId: string;
}): Promise<NumberBlockRecord> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<NumberBlockRow[]>`
      SELECT * FROM "number_blocks" WHERE "id" = ${input.id}::uuid FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      throw new NotFoundError('Number block');
    }
    assertOpen(row);

    if (row.last_used_number !== null) {
      throw new ConflictError(
        `ชุดเลขนี้ถูกใช้ถึงเลข ${row.last_used_number} แล้ว — รายงานว่าถึงเลขไหน ไม่ใช่ยกเลิก`,
        'NUMBER_BLOCK_ALREADY_USED',
      );
    }

    await tx.$executeRaw`
      UPDATE "number_blocks"
         SET "cancelled_at" = NOW(), "closed_by" = ${input.userId}::uuid
       WHERE "id" = ${row.id}::uuid
    `;
    await rewindCounter(tx, row, row.from_number - 1);

    return toRecord({ ...row, cancelled_at: new Date(), closed_by: input.userId });
  });
}

/** What is open right now — the till's state, and the admin's list of loose ends. */
export async function loadOpenNumberBlocks(kind?: NumberKind): Promise<NumberBlockRecord[]> {
  const rows = await prisma.number_blocks.findMany({
    where: {
      reported_at: null,
      cancelled_at: null,
      ...(kind ? { series: kind } : {}),
    },
    orderBy: [{ series: 'asc' }, { from_number: 'asc' }],
  });

  return rows.map((row) => toRecord(row as unknown as NumberBlockRow));
}

function assertOpen(row: NumberBlockRow): void {
  if (row.reported_at !== null || row.cancelled_at !== null) {
    throw new ConflictError(
      'ชุดเลขนี้ปิดไปแล้ว — เครื่องอาจส่งรายงานซ้ำ',
      'NUMBER_BLOCK_NOT_OPEN',
    );
  }
}

/**
 * Puts the shop's counter back where the block left it.
 *
 * The guard (`… = to_number`) is not decoration: it is the check that nobody else has
 * allocated from this series since the block was borrowed. The freeze is what makes that
 * impossible, so a miss here means the series moved for a reason this module does not
 * know about — and moving the counter anyway would corrupt it quietly. A refusal leaves
 * the block open, which is a task somebody can see.
 */
async function rewindCounter(tx: Db, row: NumberBlockRow, value: number): Promise<void> {
  const affected =
    row.series === 'receipt'
      ? await tx.$executeRaw`
          UPDATE "shops"
             SET "receipt_running_number" = ${value}
           WHERE "id" = ${SHOP_ROW_ID}
             AND "receipt_running_number" = ${row.to_number}
        `
      : await tx.$executeRaw`
          UPDATE "shops"
             SET "queue_running_number" = ${value}
           WHERE "id" = ${SHOP_ROW_ID}
             AND "queue_running_day" = ${row.day}::date
             AND "queue_running_number" = ${row.to_number}
        `;

  if (affected === 0) {
    throw new ConflictError(
      'ชุดเลขของร้านถูกใช้งานไปแล้วระหว่างที่ชุดนี้ถืออยู่ — ต้องให้ผู้ดูแลตรวจก่อน',
      'NUMBER_BLOCK_COUNTER_MOVED',
    );
  }
}
