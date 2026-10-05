/**
 * Real-time inventory — SRS §4.
 *
 * Stock is represented by two columns and one invariant:
 *
 *   stock_qty     physical units in the store
 *   reserved_qty  units claimed by live Phase 1–3 pre-orders
 *   available     stock_qty − reserved_qty        (SRS §4.1)
 *
 * Every mutation below is a single conditional `UPDATE`, so PostgreSQL's row
 * lock serialises concurrent callers for us and the check can never race
 * against the write. Nothing here reads a balance and then writes it back in a
 * separate statement: that pattern is exactly what oversells stock, and it is
 * what SRS §4.2 exists to prevent.
 *
 * One mutation is deliberately unconditional — `settleReplayedSale`, the bill a device
 * closed with no connection — and says why where it is defined: there is no guard to
 * apply to goods that are already in a customer's hands.
 */
import type { Prisma } from '../generated/prisma/client';
import { ConflictError, InsufficientStockError, NotFoundError, ValidationError } from './errors';

/**
 * Anything that can run a query: the client itself, or a transaction handle.
 * Prisma's transaction client is structurally a subset of the full client.
 */
export type Db = Prisma.TransactionClient;

/**
 * SRS §4.3 adjustment reasons, plus the import addition (ADR 0002) and the consignment
 * receipt (ADR 0025).
 *
 * `REASON_CONSIGNMENT` is here but **not** in `stockAdjustmentSchema`, on purpose. A
 * manual adjustment is a correction to the shelf, and a consignment receipt is goods
 * arriving with an owner and an agreed share behind them — the second may only be
 * written by approving a submission, which is what sets that share. Leaving it out of
 * the route a cashier can call keeps "a member left goods here" from being something a
 * cashier can assert with a number.
 */
export type StockAdjustmentReason =
  | 'REASON_RESTOCK'
  | 'REASON_DAMAGED'
  | 'REASON_EXPIRED'
  | 'REASON_CORRECTION'
  | 'REASON_IMPORT'
  | 'REASON_CONSIGNMENT';

/** SRS §7 `stock_movement_type`, plus the refund that reverses a sale (ADR 0025). */
export type StockMovementType =
  | 'manual_adjust'
  | 'pos_sale'
  | 'pos_refund'
  | 'preorder_reserve'
  | 'preorder_cancel'
  | 'restock'
  | 'consignment_received';

export interface StockBalance {
  stock_qty: number;
  reserved_qty: number;
}

/** SRS §4.1: what is actually sellable right now. */
export function availableQty(balance: { stock_qty: number; reserved_qty: number }): number {
  return balance.stock_qty - balance.reserved_qty;
}

/**
 * A restock — including an imported opening balance — is inbound stock; every
 * other reason is a human correction. Imports deliberately share the `restock`
 * movement type so they land in the same audit trail as a delivery, and only the
 * `reason` distinguishes them.
 */
export function movementTypeForReason(reason: StockAdjustmentReason): StockMovementType {
  if (reason === 'REASON_RESTOCK' || reason === 'REASON_IMPORT') {
    return 'restock';
  }
  // Its own movement type rather than `restock`: this stock belongs to a member, and a
  // report that cannot tell a delivery from a consignment cannot answer "which units on
  // this shelf are ours".
  return reason === 'REASON_CONSIGNMENT' ? 'consignment_received' : 'manual_adjust';
}

function assertPositiveQty(qty: number, label = 'quantity'): void {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new ValidationError(`${label} must be a positive whole number, received ${qty}`);
  }
}

/** Current stock and reservation counters for one product. */
export async function readStockBalance(db: Db, productId: string): Promise<StockBalance | null> {
  const rows = await db.$queryRaw<StockBalance[]>`
    SELECT "stock_qty", "reserved_qty"
      FROM "products"
     WHERE "id" = ${productId}::uuid
  `;
  return rows[0] ?? null;
}

/**
 * Moves `qty` from the available pool into `reserved_qty`.
 *
 * SRS §4.2 in full: the guard and the write are one statement, so no two
 * concurrent callers can both observe the same remaining stock. Zero rows
 * affected means the guard failed, and the caller gets a 409.
 */
export async function reserveStock(
  db: Db,
  input: { productId: string; qty: number; productName?: string },
): Promise<StockBalance> {
  assertPositiveQty(input.qty);

  const rows = await db.$queryRaw<StockBalance[]>`
    UPDATE "products"
       SET "reserved_qty" = "reserved_qty" + ${input.qty},
           "updated_at"   = NOW()
     WHERE "id" = ${input.productId}::uuid
       AND "is_active" = true
       AND ("stock_qty" - "reserved_qty") >= ${input.qty}
    RETURNING "stock_qty", "reserved_qty"
  `;

  const balance = rows[0];
  if (balance) {
    return balance;
  }

  // The guard failed. Read the row again purely to explain why in the error.
  const current = await readStockBalance(db, input.productId);
  if (!current) {
    throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${input.productId}`);
  }
  throw new InsufficientStockError(
    input.productId,
    input.qty,
    availableQty(current),
    input.productName,
  );
}

/**
 * Gives reserved units back to the available pool — used when a pre-order is
 * cancelled, expired, or has an item removed during Phase 2 confirmation.
 */
export async function releaseReservedStock(
  db: Db,
  input: { productId: string; qty: number },
): Promise<StockBalance> {
  assertPositiveQty(input.qty);

  const rows = await db.$queryRaw<StockBalance[]>`
    UPDATE "products"
       SET "reserved_qty" = "reserved_qty" - ${input.qty},
           "updated_at"   = NOW()
     WHERE "id" = ${input.productId}::uuid
       AND "reserved_qty" >= ${input.qty}
    RETURNING "stock_qty", "reserved_qty"
  `;

  const balance = rows[0];
  if (!balance) {
    throw new ConflictError(
      `Cannot release ${input.qty} reserved unit(s) of product ${input.productId}: ` +
        'the reservation is already gone',
      'RESERVATION_MISMATCH',
    );
  }
  return balance;
}

/**
 * Settles a reservation into a real sale — SRS §3 Phase 4.
 *
 * Both counters drop by the same amount, so `stock_qty − reserved_qty` is
 * unchanged and the `chk_stock_availability` invariant still holds.
 */
export async function commitReservedStock(
  db: Db,
  input: { productId: string; qty: number },
): Promise<StockBalance> {
  assertPositiveQty(input.qty);

  const rows = await db.$queryRaw<StockBalance[]>`
    UPDATE "products"
       SET "stock_qty"    = "stock_qty" - ${input.qty},
           "reserved_qty" = "reserved_qty" - ${input.qty},
           "updated_at"   = NOW()
     WHERE "id" = ${input.productId}::uuid
       AND "reserved_qty" >= ${input.qty}
       AND "stock_qty" >= ${input.qty}
    RETURNING "stock_qty", "reserved_qty"
  `;

  const balance = rows[0];
  if (!balance) {
    throw new ConflictError(
      `Cannot settle ${input.qty} unit(s) of product ${input.productId}: ` +
        'the reservation or the physical stock is missing',
      'RESERVATION_MISMATCH',
    );
  }
  return balance;
}

/** Sells `qty` immediately out of physical stock, with no reservation step. */
export async function sellFromStock(
  db: Db,
  input: { productId: string; qty: number; productName?: string },
): Promise<StockBalance> {
  assertPositiveQty(input.qty);

  const rows = await db.$queryRaw<StockBalance[]>`
    UPDATE "products"
       SET "stock_qty" = "stock_qty" - ${input.qty},
           "updated_at" = NOW()
     WHERE "id" = ${input.productId}::uuid
       AND "stock_qty" - ${input.qty} >= "reserved_qty"
    RETURNING "stock_qty", "reserved_qty"
  `;

  const balance = rows[0];
  if (balance) {
    return balance;
  }

  const current = await readStockBalance(db, input.productId);
  if (!current) {
    throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${input.productId}`);
  }
  throw new InsufficientStockError(
    input.productId,
    input.qty,
    availableQty(current),
    input.productName,
  );
}

/**
 * Puts sold goods back on the shelf because the sale was reversed.
 *
 * Unconditional, unlike `sellFromStock` and its siblings: taking stock *away*
 * has a constraint to satisfy (`stock_qty - qty >= reserved_qty`) and a customer
 * who must be told no, while putting it back cannot fail.
 *
 * It moves `stock_qty` and not `reserved_qty`, and that is the whole distinction
 * between this and `releaseReservedStock`. A refund reverses a completed sale, so
 * the units left the shelf when they were sold and there is no reservation left
 * to give back; crediting `reserved_qty` instead would make the goods unsellable
 * while looking, in every availability figure, exactly as if they had been
 * returned.
 */
export async function returnRefundedStock(
  db: Db,
  input: { productId: string; qty: number },
): Promise<StockBalance> {
  assertPositiveQty(input.qty);

  const rows = await db.$queryRaw<StockBalance[]>`
    UPDATE "products"
       SET "stock_qty" = "stock_qty" + ${input.qty},
           "updated_at" = NOW()
     WHERE "id" = ${input.productId}::uuid
    RETURNING "stock_qty", "reserved_qty"
  `;

  const balance = rows[0];
  if (!balance) {
    throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${input.productId}`);
  }
  return balance;
}

/**
 * Takes replayed offline goods off the shelf, accepting that they may already be gone.
 *
 * This is the one mutation in this file with no guard, and the missing `WHERE` is the
 * point rather than an oversight (ADR 0019 decision 3). A device that sold from a snapshot
 * can promise more than the shelf holds — another till sold the same unit, or a pre-order
 * took it — and when that bill reaches the shop the goods are *already in a customer's
 * hands*. Refusing it here would make the record contradict the receipt the customer is
 * holding, so the bill is accepted, stock is allowed to go **negative**, and the shortage
 * becomes a task somebody can see rather than a sale the shop denies.
 *
 * That is why this is a separate function from `sellFromStock` instead of a flag on it: the
 * guarded sell is the shop saying no to a customer, and this is the shop keeping its books
 * after the fact. Merging them would put the two decisions one boolean apart.
 *
 * The only refusal left is a product that no longer exists, which is a 404 rather than a
 * stock decision.
 */
export async function settleReplayedSale(
  db: Db,
  input: { productId: string; qty: number; productName?: string },
): Promise<StockBalance> {
  assertPositiveQty(input.qty);

  const rows = await db.$queryRaw<StockBalance[]>`
    UPDATE "products"
       SET "stock_qty" = "stock_qty" - ${input.qty},
           "updated_at" = NOW()
     WHERE "id" = ${input.productId}::uuid
    RETURNING "stock_qty", "reserved_qty"
  `;

  const balance = rows[0];
  if (!balance) {
    throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${input.productId}`);
  }
  return balance;
}

/**
 * Applies a signed stock correction and writes the SRS §4.3 audit row.
 *
 * The WHERE clause re-states both CHECK constraints, so an adjustment that
 * would drive stock negative — or below what live pre-orders have claimed —
 * fails as a 409 with an explanation instead of a raw constraint violation.
 */
export async function adjustStock(
  db: Db,
  input: {
    productId: string;
    delta: number;
    reason: StockAdjustmentReason;
    note: string | null;
    userId: string;
  },
): Promise<{ balance: StockBalance; logId: bigint }> {
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new ValidationError('Stock adjustment must be a non-zero whole number');
  }

  const rows = await db.$queryRaw<StockBalance[]>`
    UPDATE "products"
       SET "stock_qty" = "stock_qty" + ${input.delta},
           "updated_at" = NOW()
     WHERE "id" = ${input.productId}::uuid
       AND "stock_qty" + ${input.delta} >= 0
       AND "stock_qty" + ${input.delta} >= "reserved_qty"
    RETURNING "stock_qty", "reserved_qty"
  `;

  const balance = rows[0];
  if (!balance) {
    const current = await readStockBalance(db, input.productId);
    if (!current) {
      throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${input.productId}`);
    }
    throw new ConflictError(
      `Adjusting by ${input.delta} would leave stock at ${current.stock_qty + input.delta}, ` +
        `which is below zero or below the ${current.reserved_qty} unit(s) held by active pre-orders`,
      'STOCK_ADJUSTMENT_INVALID',
    );
  }

  const log = await db.stock_logs.create({
    data: {
      product_id: input.productId,
      changed_by: input.userId,
      movement_type: movementTypeForReason(input.reason),
      reason: input.reason,
      qty_changed: input.delta,
      balance_after: balance.stock_qty,
      note: input.note,
    },
  });

  return { balance, logId: log.id };
}

/** Appends an audit row for a movement the caller already performed. */
export async function recordStockMovement(
  db: Db,
  input: {
    productId: string;
    userId: string;
    movementType: StockMovementType;
    qtyChanged: number;
    balanceAfter: number;
    note?: string | null;
  },
): Promise<void> {
  await db.stock_logs.create({
    data: {
      product_id: input.productId,
      changed_by: input.userId,
      movement_type: input.movementType,
      reason: null,
      qty_changed: input.qtyChanged,
      balance_after: input.balanceAfter,
      note: input.note ?? null,
    },
  });
}
