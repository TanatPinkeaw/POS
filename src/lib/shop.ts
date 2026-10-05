/**
 * Shop identity, tax settings and receipt numbering (ADR 0002).
 *
 * The SRS has no concept of "the shop" — its name, address and tax id were
 * hardcoded into page titles and the receipt — so this module is an addition
 * rather than an implementation of a requirement. It exists so a renter can
 * configure their own shop without editing code.
 *
 * Two decisions are worth knowing before reading on:
 *
 *   1. **The shop is a singleton.** The migration's `CHECK (id = 1)` plus the
 *      primary key make a second row impossible, which is what makes the setup
 *      wizard safe against two racing requests.
 *   2. **Receipt numbers are allocated, not invented.** See
 *      `allocateReceiptNumber`: the counter is bumped by an `UPDATE … RETURNING`
 *      inside the caller's transaction, so a sale that rolls back does not burn
 *      a number and the series stays gapless.
 */
import { Prisma, type shops } from '../generated/prisma/client';

import { bangkokDateString, bangkokParts, dateColumnFromDay } from './bangkok-time';
import { prisma } from './db';
import { ConflictError, SeriesReservedError } from './errors';
import type { Db } from './inventory';
import { fromDecimal } from './money';
import type { NumberKind } from './number-block';
import { normalisePromptPayId, type PromptPayIdType } from './promptpay';
import {
  DEFAULT_SUPERVISOR_DISCOUNT_LIMIT,
  formatCreditNoteNumber,
  formatReceiptNumber,
  type ShopView,
} from './shop-view';

/** There is exactly one shop row, and this is its primary key. */
export const SHOP_ROW_ID = 1;

export interface ShopSettingsInput {
  name: string;
  legalName?: string | null;
  branchLabel?: string | null;
  taxId?: string | null;
  address?: string | null;
  phone?: string | null;
  isVatRegistered: boolean;
  vatRate: number;
  receiptPrefix: string;
  receiptFooter?: string | null;
  logoUrl?: string | null;
  /** Omitted leaves the column alone — the DB default covers a new shop. */
  supervisorDiscountLimitThb?: number;
  /**
   * Both or neither: the till cannot build a payload from an id without knowing
   * which kind of account it is, so half a setting is refused at the schema.
   */
  promptpayId?: string | null;
  promptpayType?: PromptPayIdType | null;
}

/**
 * The VAT facts a sale needs.
 *
 * `configured` is false before setup has run, in which case a sale still works
 * but records no tax: that keeps an unconfigured deployment (and the integration
 * tests, which never create a shop) behaving exactly as they did before VAT
 * existed, while still satisfying the order's VAT reconstruction constraint.
 */
export interface ShopVatSettings {
  configured: boolean;
  isVatRegistered: boolean;
  vatRate: number;
  pricesIncludeVat: boolean;
}

const UNCONFIGURED_VAT: ShopVatSettings = {
  configured: false,
  isVatRegistered: false,
  vatRate: 0,
  pricesIncludeVat: true,
};

export function toShopView(row: shops): ShopView {
  return {
    name: row.name,
    legalName: row.legal_name,
    branchLabel: row.branch_label,
    taxId: row.tax_id,
    address: row.address,
    phone: row.phone,
    isVatRegistered: row.is_vat_registered,
    vatRate: fromDecimal(row.vat_rate),
    pricesIncludeVat: row.prices_include_vat,
    receiptPrefix: row.receipt_prefix,
    receiptRunningNumber: Number(row.receipt_running_number),
    receiptFooter: row.receipt_footer,
    logoUrl: row.logo_url,
    promptpayId: row.promptpay_id,
    promptpayType: (row.promptpay_type as PromptPayIdType | null) ?? null,
    supervisorDiscountLimitThb: fromDecimal(row.supervisor_discount_limit_thb),
  };
}

/** The configured shop, or null before setup has run. */
export async function loadShop(): Promise<ShopView | null> {
  const row = await prisma.shops.findUnique({ where: { id: SHOP_ROW_ID } });
  return row ? toShopView(row) : null;
}

/**
 * The discount a cashier may give without a supervisor's PIN.
 *
 * Read per sale rather than cached: an owner lowering the limit mid-shift
 * expects the next discount to be judged by the new number, and a module-level
 * cache would keep the old one until the process restarted. Falls back to the
 * default on an unconfigured shop, which is the same answer `toShopView`
 * gives — the two must agree, or the till would prompt for a PIN the server
 * does not require.
 */
export async function supervisorDiscountLimit(db: Db = prisma): Promise<number> {
  const row = await db.shops.findUnique({
    where: { id: SHOP_ROW_ID },
    select: { supervisor_discount_limit_thb: true },
  });
  return row
    ? fromDecimal(row.supervisor_discount_limit_thb)
    : DEFAULT_SUPERVISOR_DISCOUNT_LIMIT;
}

/** Whether this deployment has been set up. */
export async function hasShop(): Promise<boolean> {
  const count = await prisma.shops.count();
  return count > 0;
}

/**
 * Creates the one shop row.
 *
 * A second attempt is a 409 rather than a silent overwrite, and it is the
 * database that decides: the insert collides on the primary key even if two
 * requests passed the wizard's `hasShop()` check at the same instant.
 */
export async function createShop(input: ShopSettingsInput): Promise<ShopView> {
  try {
    const row = await prisma.shops.create({
      data: { id: SHOP_ROW_ID, ...shopColumns(input) },
    });
    return toShopView(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('ระบบนี้ตั้งค่าเรียบร้อยแล้ว', 'ALREADY_INITIALISED');
    }
    throw error;
  }
}

/** Applies edited settings to the existing shop row. */
export async function updateShop(input: ShopSettingsInput): Promise<ShopView> {
  const existing = await prisma.shops.findUnique({ where: { id: SHOP_ROW_ID }, select: { id: true } });
  if (!existing) {
    throw new ConflictError('กรุณาตั้งค่าร้านก่อนจึงจะแก้ไขข้อมูลร้านได้', 'SHOP_NOT_CONFIGURED');
  }

  const row = await prisma.shops.update({
    where: { id: SHOP_ROW_ID },
    data: shopColumns(input),
  });
  return toShopView(row);
}

/**
 * Reads the tax settings *inside* the caller's transaction.
 *
 * Deliberately not cached in module scope: an admin editing the VAT rate while a
 * sale is in flight must not be able to make the order and its receipt disagree,
 * and reading through `db` puts the read on the same connection and snapshot as
 * the write that follows it.
 */
export async function loadVatSettings(db: Db = prisma): Promise<ShopVatSettings> {
  const row = await db.shops.findUnique({
    where: { id: SHOP_ROW_ID },
    select: { is_vat_registered: true, vat_rate: true, prices_include_vat: true },
  });

  if (!row) {
    return UNCONFIGURED_VAT;
  }

  return {
    configured: true,
    isVatRegistered: row.is_vat_registered,
    vatRate: fromDecimal(row.vat_rate),
    pricesIncludeVat: row.prices_include_vat,
  };
}

/**
 * Reserves the next receipt number for a sale, or null when no shop is set up.
 *
 * Why not `nextval` on a sequence, the way order numbers are minted? Because
 * Postgres sequences are non-transactional: a sale that rolls back after calling
 * `nextval` still consumes the number, and a tax receipt series with holes in it
 * is a document series an auditor will ask about. Bumping a column inside the
 * transaction makes rollback restore the counter with everything else.
 *
 * The cost is that receipt issuance serialises on the shop row. That is a real
 * tradeoff and a deliberate one — it is correct for one till, and it is the
 * thing to revisit before a shop runs two registers (ADR 0002).
 *
 * **The freeze (ADR 0019).** While a device is holding unreported numbers from this
 * series, nothing here may allocate: the device will report the *last number it
 * printed*, and the counter is set back to it, so a number issued in between could not
 * be placed in the series afterwards. That is why the condition travels inside the
 * statement rather than being checked beside it — a check and an update that can be
 * interleaved are two chances to issue a number into a reserved range. The partial
 * index on `number_blocks` is the same predicate, so asking costs nothing.
 *
 * Offline the till is the allocator (it holds the block), which is what leaves this path
 * for a sale that arrives without a device number at all: a shop that has never borrowed
 * numbers, the acceptance scripts, and the office.
 */
export async function allocateReceiptNumber(
  db: Db,
  at: Date = new Date(),
): Promise<{ receiptNumber: string; shop: ShopView } | null> {
  const rows = await db.$queryRaw<shops[]>`
    UPDATE "shops"
       SET "receipt_running_number" = "receipt_running_number" + 1
     WHERE "id" = ${SHOP_ROW_ID}
       AND NOT EXISTS (
         SELECT 1 FROM "number_blocks" b
          WHERE b."series" = 'receipt'
            AND b."reported_at" IS NULL
            AND b."cancelled_at" IS NULL
       )
    RETURNING *
  `;

  const row = rows[0];
  if (!row) {
    /*
     * No shop at all, or a frozen series. The two are told apart because they mean
     * completely different things to whoever is at the till: one is a deployment that
     * was never set up, the other is a bill that has to wait for a sync.
     */
    if (await isSeriesReserved(db, 'receipt')) {
      throw new SeriesReservedError('receipt');
    }
    return null;
  }

  return {
    receiptNumber: formatReceiptNumber(
      row.receipt_prefix,
      bangkokParts(at).year,
      Number(row.receipt_running_number),
    ),
    shop: toShopView(row),
  };
}

/**
 * The number the queue counter must resume from on `day`, as a SQL fragment.
 *
 * The shop row remembers the last number it issued, but `queue_running_day` resets the
 * counter at Bangkok midnight — and a blind reset to zero is exactly the bug this guards.
 * A device that reserved tomorrow's call numbers before today ended has already advanced
 * the counter, so "start again at 1" would reissue numbers that are already printed on
 * slips. History is what keeps the reset honest: the highest number actually sold today
 * (`orders.queue_number`) and the highest reported loan mark for today
 * (`number_blocks.last_used_number`) — whichever is further.
 *
 * A fragment rather than two inline expressions because `allocateQueueNumber` here and
 * `openNumberBlock` in `number-blocks.ts` need precisely this, and a second copy of a
 * numbering rule is a second answer that cannot afford to drift.
 */
export function queueCounterSeed(day: string | null): Prisma.Sql {
  return Prisma.sql`GREATEST(
               COALESCE((SELECT MAX(queue_number) FROM orders WHERE queue_day = ${day}::date), 0),
               COALESCE((SELECT MAX(last_used_number) FROM number_blocks WHERE series = 'queue' AND day = ${day}::date AND reported_at IS NOT NULL), 0)
             )`;
}

/**
 * Reserves the next call number for the day, or null when no shop is set up.
 *
 * Same serialisation as `allocateReceiptNumber`, and for the same reason: the
 * counter is bumped by an `UPDATE … RETURNING` inside the caller's transaction, so
 * a sale that rolls back restores the counter with it and no customer is called by
 * a number that was never handed out.
 *
 * The day rollover is decided *inside* that statement rather than by reading the
 * row and comparing in TypeScript. A read-then-write would need `SELECT … FOR
 * UPDATE` on the row every sale already touches, and — the real reason — "is this
 * the same day?" and "bump the counter" would then be two statements that can be
 * interleaved by another register. Here they are one, so the number this returns
 * belongs to the day it names. Only *which* day is a database question that has to
 * be asked in the database; what the number looks like is the pure rule in
 * `queue-number.ts`, which is also what the receipt and the board print from.
 *
 * Left unformatted on purpose: this returns what the columns store — the integer
 * and the Bangkok day as a `@db.Date` value — and formatting happens where the
 * number is shown to somebody.
 */
export async function allocateQueueNumber(
  db: Db,
  at: Date = new Date(),
): Promise<{ value: number; day: Date } | null> {
  const day = bangkokDateString(at);

  const rows = await db.$queryRaw<{ queue_running_number: number }[]>`
    UPDATE "shops"
       SET "queue_running_number" = CASE
             WHEN "queue_running_day" = ${day}::date THEN "queue_running_number" + 1
             ELSE ${queueCounterSeed(day)} + 1
           END,
           "queue_running_day" = ${day}::date
     WHERE "id" = ${SHOP_ROW_ID}
       AND NOT EXISTS (
         SELECT 1 FROM "number_blocks" b
          WHERE b."series" = 'queue'
            AND b."day" = ${day}::date
            AND b."reported_at" IS NULL
            AND b."cancelled_at" IS NULL
       )
    RETURNING "queue_running_number"
  `;

  const row = rows[0];
  if (!row) {
    /*
     * Null here is "this bill gets no call number", not an error, and that is a
     * deliberate asymmetry with the receipt series: a tax invoice without a number
     * cannot be issued at all, while a customer can be handed their drink with a slip
     * that has no number on it. The block that caused it is a visible open row, and the
     * bill is otherwise ordinary.
     */
    return null;
  }

  return { value: Number(row.queue_running_number), day: dateColumnFromDay(day) };
}

/**
 * Whether a device is holding unreported numbers from one of the shop's series
 * (ADR 0019).
 *
 * Asked by the allocators above, and by the screens that have to show a shop why it
 * cannot sell: an open block is a fact about the shop, not a private detail of the device
 * that holds it.
 */
export async function isSeriesReserved(db: Db, series: NumberKind): Promise<boolean> {
  const rows = await db.$queryRaw<{ present: number }[]>`
    SELECT 1 AS present FROM "number_blocks"
     WHERE "series" = ${series}::"number_series"
       AND "reported_at" IS NULL
       AND "cancelled_at" IS NULL
     LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Takes the shop row's lock, so that a transaction which needs it *first* can say so.
 *
 * Every document series in this application lives on this one row, and a transaction
 * that ends up holding two rows takes them in one order: **the shop row, then anything
 * else**. The sale path gets this for free — the call number is allocated before any
 * product row is touched — but the number-block paths are the other way round, because
 * they begin by locking the block they are about. ADR 0019 put a block and the shop row
 * in the same transaction, and that is what turns a difference in order into a deadlock:
 * a borrow holds this row and waits for the block a report is holding, while the report
 * waits for this row.
 *
 * Callers that never touch a block do not need to call this — the allocators below take
 * the same lock as part of the statement that bumps the counter.
 */
export async function lockShopRow(db: Db = prisma): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "shops" WHERE "id" = ${SHOP_ROW_ID} FOR UPDATE`;
}

/**
 * Reserves the next credit-note number, or null when no shop is set up.
 *
 * Same trade-off as `allocateReceiptNumber`, and for the same reason: a
 * credit-note series with holes in it cannot be reconciled against the invoice
 * series it reverses, so the counter is bumped by an `UPDATE … RETURNING` inside
 * the caller's transaction — a refund that rolls back restores the counter with
 * everything else.
 *
 * **Call this first inside the refund transaction**, before any product row is
 * touched. Every transaction in this application takes the shop row's lock in
 * the same order for the same reason, and the note in `createPosSale` explains
 * what the opposite order costs: one register holding the shop row while it
 * waits for a product the other register holds.
 */
export async function allocateCreditNoteNumber(
  db: Db,
  at: Date = new Date(),
): Promise<{ documentNumber: string; shop: ShopView } | null> {
  const rows = await db.$queryRaw<shops[]>`
    UPDATE "shops"
       SET "credit_note_running_number" = "credit_note_running_number" + 1
     WHERE "id" = ${SHOP_ROW_ID}
    RETURNING *
  `;

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    documentNumber: formatCreditNoteNumber(
      row.credit_note_prefix,
      bangkokParts(at).year,
      Number(row.credit_note_running_number),
    ),
    shop: toShopView(row),
  };
}

export function shopColumns(input: ShopSettingsInput) {
  return {
    name: input.name.trim(),
    legal_name: blankToNull(input.legalName),
    branch_label: blankToNull(input.branchLabel),
    tax_id: blankToNull(input.taxId),
    address: blankToNull(input.address),
    phone: blankToNull(input.phone),
    is_vat_registered: input.isVatRegistered,
    vat_rate: input.vatRate,
    // Inclusive pricing is the only mode the sale path supports; the settings
    // API refuses `false` rather than storing a mode that would compute the
    // wrong tax. See ADR 0002.
    prices_include_vat: true,
    receipt_prefix: input.receiptPrefix.trim(),
    receipt_footer: blankToNull(input.receiptFooter),
    logo_url: blankToNull(input.logoUrl),
    /*
     * Normalised on the way in, so what is stored is exactly what the payload
     * builder will carry. A shop that typed 081-234-5678 gets 0066812345678.
     */
    ...(input.promptpayId === undefined
      ? {}
      : {
          promptpay_id: normalisePromptPayId(input.promptpayType ?? 'mobile', input.promptpayId ?? ''),
          promptpay_type: input.promptpayType ?? 'mobile',
        }),
    /*
     * Spread rather than always written, because the same helper serves insert
     * and update: omitting it on insert lets the column's own default apply, and
     * omitting it on update leaves the shop's policy alone. Writing a fallback
     * here would silently reset a configured limit to 50 every time an admin
     * saved the VAT rate.
     */
    ...(input.supervisorDiscountLimitThb === undefined
      ? {}
      : { supervisor_discount_limit_thb: input.supervisorDiscountLimitThb }),
  };
}

/** An empty form field means "not provided", not an empty string. */
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Detects Prisma's unique-constraint error without importing its error classes,
 * which keeps the generated client out of this module's runtime imports.
 */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}
