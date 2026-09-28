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
import type { shops } from '../generated/prisma/client';

import { bangkokParts } from './bangkok-time';
import { prisma } from './db';
import { ConflictError } from './errors';
import type { Db } from './inventory';
import { fromDecimal } from './money';
import { formatReceiptNumber, type ShopView } from './shop-view';

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
  };
}

/** The configured shop, or null before setup has run. */
export async function loadShop(): Promise<ShopView | null> {
  const row = await prisma.shops.findUnique({ where: { id: SHOP_ROW_ID } });
  return row ? toShopView(row) : null;
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
      throw new ConflictError('This system has already been set up', 'ALREADY_INITIALISED');
    }
    throw error;
  }
}

/** Applies edited settings to the existing shop row. */
export async function updateShop(input: ShopSettingsInput): Promise<ShopView> {
  const existing = await prisma.shops.findUnique({ where: { id: SHOP_ROW_ID }, select: { id: true } });
  if (!existing) {
    throw new ConflictError('Set this system up before editing shop settings', 'SHOP_NOT_CONFIGURED');
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
 */
export async function allocateReceiptNumber(
  db: Db,
  at: Date = new Date(),
): Promise<{ receiptNumber: string; shop: ShopView } | null> {
  const rows = await db.$queryRaw<shops[]>`
    UPDATE "shops"
       SET "receipt_running_number" = "receipt_running_number" + 1
     WHERE "id" = ${SHOP_ROW_ID}
    RETURNING *
  `;

  const row = rows[0];
  if (!row) {
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
