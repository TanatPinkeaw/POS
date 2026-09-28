/**
 * Catalogue import — the database half.
 *
 * Split from `import-spec.ts` the same way `reports.ts` is split from
 * `report-spec.ts`: everything decidable about a row without a database is
 * decided there and unit-tested; this module only answers "is there already a
 * product for this row, and what does committing it do".
 *
 * Two rules are worth stating plainly, because they are what a renter will
 * notice:
 *
 *   1. **Stock is added, never set.** The sheet's stock column is an opening
 *      balance that is applied as a delta through `adjustStock`, so every
 *      imported quantity produces a `stock_logs` row like any other movement.
 *      An import must not be a hole in the audit trail.
 *   2. **A row is matched by barcode, falling back to name.** A sheet without
 *      barcodes then behaves predictably — same name means same product.
 *
 * `previewProductImport` never throws on bad data: it reports every problem so a
 * 300-row sheet is fixed in one pass rather than one upload per typo. Committing
 * then applies every valid row in a single transaction and skips the invalid
 * ones, reporting how many were dropped. That is a deliberate trade: losing 3
 * rows to a typo is recoverable in a minute, whereas refusing all 300 because of
 * them means a renter gives up on the import entirely.
 */
import type { Prisma } from '../generated/prisma/client';

import { prisma } from './db';
import { ValidationError } from './errors';
import {
  parseImportGrid,
  type ImportField,
  type ImportIssue,
  type ImportRow,
} from './import-spec';
import { adjustStock, type Db } from './inventory';
import { fromDecimal } from './money';

/** A larger ceiling than a sale: a first import can legitimately be thousands of rows. */
const IMPORT_TRANSACTION_OPTIONS = { timeout: 120_000, maxWait: 30_000 } as const;

export interface ImportPreviewRow extends ImportRow {
  action: 'create' | 'update';
  existingProductId: string | null;
  currentStock: number;
  /** What stock becomes if this row is imported: `currentStock + stockQty`. */
  resultingStock: number;
  /** True when the row would change a price that is already set. */
  changesPrice: boolean;
}

export interface ProductImportPreview {
  mapping: Partial<Record<ImportField, number>>;
  /** File-level problems; when present, no row can be judged. */
  issues: ImportIssue[];
  rows: ImportPreviewRow[];
  createCount: number;
  updateCount: number;
  invalidCount: number;
  stockAddedTotal: number;
}

export interface ProductImportSummary {
  created: number;
  updated: number;
  stockAddedTotal: number;
  skipped: number;
}

/** Products this many rows at a time, keyed for matching. */
interface MatchIndex {
  byBarcode: Map<string, { id: string; stockQty: number; salePrice: number; costPrice: number }>;
  byName: Map<string, { id: string; stockQty: number; salePrice: number; costPrice: number }>;
}

/**
 * Describes what committing this file would do, without doing any of it.
 *
 * The renter sees every row — including the bad ones — plus the resulting stock
 * and whether a price is about to be overwritten, before anything is written.
 */
export async function previewProductImport(grid: string[][]): Promise<ProductImportPreview> {
  const parsed = parseImportGrid(grid);

  if (parsed.issues.length > 0) {
    return {
      mapping: parsed.mapping,
      issues: parsed.issues,
      rows: [],
      createCount: 0,
      updateCount: 0,
      invalidCount: 0,
      stockAddedTotal: 0,
    };
  }

  const index = await buildMatchIndex(prisma, parsed.rows);

  const rows: ImportPreviewRow[] = parsed.rows.map((row) => {
    const match = findMatch(index, row);
    const action: 'create' | 'update' = match ? 'update' : 'create';
    const changesPrice =
      match !== null &&
      (match.salePrice !== row.salePrice || match.costPrice !== row.costPrice) &&
      row.issues.length === 0;

    return {
      ...row,
      action,
      existingProductId: match?.id ?? null,
      currentStock: match?.stockQty ?? 0,
      resultingStock: (match?.stockQty ?? 0) + row.stockQty,
      changesPrice,
    };
  });

  const importable = rows.filter((row) => row.issues.length === 0);

  return {
    mapping: parsed.mapping,
    issues: [],
    rows,
    createCount: importable.filter((row) => row.action === 'create').length,
    updateCount: importable.filter((row) => row.action === 'update').length,
    invalidCount: rows.length - importable.length,
    stockAddedTotal: importable.reduce((total, row) => total + row.stockQty, 0),
  };
}

/**
 * Applies the valid rows from a file.
 *
 * One transaction, so an unexpected database failure part-way through leaves the
 * catalogue exactly as it was rather than half-imported with no record of how
 * far it got. Invalid *rows* are skipped rather than aborting the file — the
 * preview has already shown the renter which ones they are, and the return value
 * reports the count.
 */
export async function commitProductImport(
  grid: string[][],
  actorId: string,
): Promise<ProductImportSummary> {
  const parsed = parseImportGrid(grid);

  if (parsed.issues.length > 0) {
    throw new ValidationError(parsed.issues.map((issue) => issue.message).join(' · '));
  }
  if (parsed.validRows.length === 0) {
    throw new ValidationError('There is nothing to import: no row in this file is valid');
  }


  return prisma.$transaction(async (tx) => {
    const index = await buildMatchIndex(tx, parsed.rows);
    let created = 0;
    let updated = 0;
    let stockAddedTotal = 0;

    for (const row of parsed.validRows) {
      const categoryId = row.categoryName ? await resolveCategory(tx, row.categoryName) : null;
      const match = findMatch(index, row);

      const product = match
        ? await tx.products.update({
            where: { id: match.id },
            data: {
              name: row.name,
              category_id: categoryId ?? undefined,
              cost_price: row.costPrice,
              sale_price: row.salePrice,
              description: row.description,
              image_url: row.imageUrl,
            },
          })
        : await tx.products.create({
            data: {
              name: row.name,
              barcode: row.barcode,
              category_id: categoryId,
              cost_price: row.costPrice,
              sale_price: row.salePrice,
              description: row.description,
              image_url: row.imageUrl,
              // Opening stock arrives through `adjustStock` below, not here, so
              // that it is recorded in `stock_logs` like every other movement.
              stock_qty: 0,
            },
          });

      if (match) {
        updated += 1;
      } else {
        created += 1;
        // Keep the in-transaction index honest, so two rows naming one new
        // product cannot both try to create it.
        index.byName.set(nameKey(row.name), {
          id: product.id,
          stockQty: 0,
          salePrice: row.salePrice,
          costPrice: row.costPrice,
        });
        if (row.barcode) {
          index.byBarcode.set(row.barcode, {
            id: product.id,
            stockQty: 0,
            salePrice: row.salePrice,
            costPrice: row.costPrice,
          });
        }
      }

      if (row.stockQty > 0) {
        await adjustStock(tx, {
          productId: product.id,
          delta: row.stockQty,
          reason: 'REASON_IMPORT',
          note: `Imported opening balance for "${row.name}" (line ${row.line})`,
          userId: actorId,
        });
        stockAddedTotal += row.stockQty;
      }
    }

    return {
      created,
      updated,
      stockAddedTotal,
      skipped: parsed.invalidRows.length,
    };
  }, IMPORT_TRANSACTION_OPTIONS);
}

/**
 * Loads the products this file could refer to, in two queries rather than one
 * per row: an import that queries per row is 300 round trips instead of 2.
 */
async function buildMatchIndex(db: Db, rows: ImportRow[]): Promise<MatchIndex> {
  const barcodes = rows.map((row) => row.barcode).filter((value): value is string => value !== null);
  const names = rows.map((row) => row.name).filter((value) => value !== '');

  const products = await db.products.findMany({
    where: {
      OR: [
        ...(barcodes.length > 0 ? [{ barcode: { in: barcodes } }] : []),
        ...(names.length > 0 ? [{ name: { in: names } }] : []),
      ],
    },
    select: { id: true, name: true, barcode: true, stock_qty: true, sale_price: true, cost_price: true },
  });

  const index: MatchIndex = { byBarcode: new Map(), byName: new Map() };

  for (const product of products) {
    const entry = {
      id: product.id,
      stockQty: product.stock_qty,
      salePrice: fromDecimal(product.sale_price),
      costPrice: fromDecimal(product.cost_price),
    };
    if (product.barcode) {
      index.byBarcode.set(product.barcode, entry);
    }
    index.byName.set(nameKey(product.name), entry);
  }

  return index;
}

function findMatch(index: MatchIndex, row: ImportRow) {
  if (row.barcode) {
    const byBarcode = index.byBarcode.get(row.barcode);
    if (byBarcode) {
      return byBarcode;
    }
  }
  return index.byName.get(nameKey(row.name)) ?? null;
}

/** Product names are matched case-insensitively and ignoring surrounding space. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Finds or creates the category a row names.
 *
 * Creating on demand is what lets a renter's first upload be their real
 * spreadsheet: a category column is part of how they think about their stock,
 * and requiring them to pre-create 12 categories first is friction with no
 * purpose. Within the transaction the lookup sees rows created earlier in the
 * same file, so "เครื่องดื่ม" is created once.
 */
async function resolveCategory(db: Db, name: string): Promise<number> {
  const trimmed = name.trim();
  const existing = await db.categories.findFirst({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) {
    return existing.id;
  }

  const created = await db.categories.create({ data: { name: trimmed } });
  return created.id;
}

/** Exposed for the route, which reports these as 422s rather than 500s. */
export type { ImportIssue };
export type PrismaImport = Prisma.TransactionClient;
