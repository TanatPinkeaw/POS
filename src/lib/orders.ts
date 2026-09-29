/**
 * Orders — SRS §3 and §6.2.
 *
 * The four-phase pre-order lifecycle, walk-in POS sales, and settlement all
 * live here. Every operation runs in one interactive transaction so that a
 * half-applied order is impossible: if settling the payment fails, the stock
 * reservation is rolled back with it.
 */
import { recordAudit } from './audit';
import { prisma } from './db';
import { optionalNumberEnv } from './env';
import { ConflictError, NotFoundError, ValidationError } from './errors';
import {
  commitReservedStock,
  type Db,
  recordStockMovement,
  releaseReservedStock,
  reserveStock,
  sellFromStock,
} from './inventory';
import { pointsEarned as computePointsEarned } from './loyalty';
/*
 * The outbox is written from inside the order transactions, deliberately: a
 * message about an order has to commit with the order, or a process that dies
 * between the two leaves a customer who is never told their parcel is waiting.
 * Only the planner and the outbox are imported — never a transport — so this
 * module still has no idea how a message travels.
 */
import {
  planOrderReadyNotification,
  planPreOrderPlacedNotification,
  readNotifyConfig,
} from './notify-message';
import { enqueueNotification } from './notify-outbox';
import { consumeIntent } from './payment-intents';
import { fromDecimal, roundThb, sumThb } from './money';
import { canTransition, type OrderStatus } from './order-state';
import { verifyPickupToken } from './pickup-token';
import { applyPointChange } from './points';
import { buildSettlement, type SettlementBreakdown, type SettlementRequest } from './settlement';
import { allocateReceiptNumber, loadVatSettings } from './shop';
import { SYSTEM_USER_ID } from './system-user';
import type { TenderLine } from './tender';
import { computeVat, type VatBreakdown } from './vat';

/** Long enough for 50 concurrent settlements to queue on one product's row lock. */
const TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 30_000 } as const;

export interface CartLine {
  productId: string;
  quantity: number;
}

interface PricedLine {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  totalPrice: number;
}

export interface OrderLineSummary {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface OrderSummary {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  subtotalThb: number;
  discountThb: number;
  finalAmountThb: number;
  paidThb: number;
  changeThb: number;
  /** What was handed over, per method — the figures `รับเงิน` prints. */
  tenders: TenderLine[];
  pointsEarned: number;
  pointsRedeemed: number;
  lines: OrderLineSummary[];
  /** Null when the shop is not VAT-registered, or has not been set up. */
  receiptNumber: string | null;
  isVatInvoice: boolean;
  vatRatePercent: number | null;
  /** The taxable base and the tax itself, as snapshotted on the order. */
  netThb: number;
  vatThb: number;
}

/** SRS §3 Phase 1: how long an unconfirmed pre-order may live. */
export function confirmTimeoutMinutes(): number {
  return optionalNumberEnv('PREORDER_CONFIRM_TIMEOUT_MINUTES', 15);
}

/** SRS §3 Phase 3: how long a packed order is held before it can be a no-show. */
export function pickupHoldHours(): number {
  return optionalNumberEnv('PREORDER_HOLD_HOURS', 4);
}

/**
 * Reads the cart's products and freezes their prices.
 *
 * Prices are copied onto the order rather than referenced, so that an admin
 * editing a price tomorrow cannot rewrite what a customer paid today.
 */
async function priceCart(db: Db, lines: CartLine[]): Promise<PricedLine[]> {
  if (lines.length === 0) {
    throw new ValidationError('An order needs at least one item');
  }

  // Merge duplicate product ids so a cart cannot smuggle in two lines of the
  // same item that individually fit but together do not.
  const requested = new Map<string, number>();
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError(
        `Quantity for ${line.productId} must be a positive whole number`,
      );
    }
    requested.set(line.productId, (requested.get(line.productId) ?? 0) + line.quantity);
  }

  const products = await db.products.findMany({
    where: { id: { in: [...requested.keys()] } },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  const priced: PricedLine[] = [];
  for (const [productId, quantity] of requested) {
    const product = byId.get(productId);
    if (!product) {
      throw new NotFoundError(`Product ${productId}`);
    }
    if (!product.is_active) {
      throw new ConflictError(`"${product.name}" is no longer for sale`, 'PRODUCT_INACTIVE');
    }

    const unitPrice = fromDecimal(product.sale_price);
    priced.push({
      productId,
      name: product.name,
      quantity,
      unitPrice,
      unitCost: fromDecimal(product.cost_price),
      totalPrice: roundThb(unitPrice * quantity),
    });
  }

  return priced;
}

/**
 * Mints the next order number from the sequence created in the initial migration.
 *
 * The date is taken in Bangkok explicitly rather than from the session's
 * timezone. Between midnight and 07:00 local the two disagree, and an order
 * numbered with yesterday's date is the kind of thing a shop notices and nobody
 * can reproduce later.
 */
async function nextOrderNumber(db: Db): Promise<string> {
  const rows = await db.$queryRaw<{ order_number: string }[]>`
    SELECT 'PO-' || to_char(NOW() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD') || '-' ||
           lpad(nextval('order_number_seq')::text, 6, '0') AS order_number
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Failed to allocate an order number');
  }
  return row.order_number;
}

/**
 * Takes a row lock on the order for the duration of the transaction.
 *
 * Without this, two employees pressing "Confirm" at the same instant would both
 * read status `pending`, both pass the state check, and both proceed.
 *
 * Exported because the refund path in `credit-notes.ts` needs exactly this and
 * must not grow a second copy of it: the lock is only worth taking if every
 * writer takes it the same way, and "first lock the order, then check the
 * transition" has to be one rule rather than a habit at each call site.
 */
export async function lockOrder(db: Db, orderId: string): Promise<{ id: string; status: OrderStatus }> {
  const rows = await db.$queryRaw<{ id: string; status: OrderStatus }[]>`
    SELECT "id", "status" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    throw new NotFoundError(`Order ${orderId}`);
  }
  return row;
}

/** A 4-digit handover PIN that no other order currently holds. */
async function allocatePickupPin(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pin = String(1000 + Math.floor(Math.random() * 9000));
    const clash = await db.orders.findFirst({
      where: { pickup_pin: pin, status: 'ready_for_pickup' },
      select: { id: true },
    });
    if (!clash) {
      return pin;
    }
  }
  throw new ConflictError(
    'Could not allocate a unique pickup PIN after 50 attempts',
    'PIN_ALLOCATION_FAILED',
  );
}

async function customerPointsBalance(db: Db, customerId: string | null): Promise<number> {
  if (!customerId) {
    return 0;
  }
  const user = await db.users.findUnique({
    where: { id: customerId },
    select: { points_balance: true },
  });
  return user?.points_balance ?? 0;
}

/**
 * The tax facts frozen onto one sale, plus the receipt number it consumes.
 */
interface SaleTax {
  breakdown: VatBreakdown;
  receiptNumber: string | null;
  vatRateUsed: number | null;
}

/**
 * Snapshots the shop's tax settings onto a sale.
 *
 * Called from inside the sale transaction and read through `db`, so the rate the
 * order records is the one the receipt prints, even if an admin edits the VAT
 * rate in the next room while this sale is in flight.
 *
 * Note the arithmetic this deliberately does *not* change: with inclusive
 * pricing — the Thai retail norm and the only mode supported — `amountThb` is
 * already the amount the customer pays, so only the breakdown is new. The
 * pre-existing sale totals are untouched, which is why introducing VAT did not
 * move a single figure in the sale path's tests.
 */
async function resolveSaleTax(db: Db, amountThb: number, at: Date): Promise<SaleTax> {
  const settings = await loadVatSettings(db);

  /*
   * VAT-exclusive pricing is refused rather than approximated. Deriving the tax
   * the other way round changes what the customer owes, which changes what the
   * settlement is built on, which changes the points discount — and getting that
   * circular dependency subtly wrong would put a wrong tax figure on a legal
   * document. The settings API already refuses to store this mode; this guard
   * catches a value edited directly into the database.
   */
  if (settings.configured && !settings.pricesIncludeVat) {
    throw new ConflictError(
      'This shop is set to VAT-exclusive pricing, which this version does not support yet',
      'VAT_MODE_UNSUPPORTED',
    );
  }

  const breakdown = computeVat({
    amountThb,
    ratePercent: settings.vatRate,
    pricesIncludeVat: settings.pricesIncludeVat,
    isVatRegistered: settings.isVatRegistered,
  });

  // Only a sale that may issue a tax invoice consumes a number from the series.
  const allocation = breakdown.isVatInvoice ? await allocateReceiptNumber(db, at) : null;

  return {
    breakdown,
    receiptNumber: allocation?.receiptNumber ?? null,
    vatRateUsed: breakdown.isVatInvoice ? breakdown.ratePercent : null,
  };
}

/** The order columns a `SaleTax` maps onto. */
function taxColumns(tax: SaleTax) {
  return {
    net_amount: tax.breakdown.netThb,
    vat_amount: tax.breakdown.vatThb,
    vat_rate_used: tax.vatRateUsed,
    is_vat_invoice: tax.breakdown.isVatInvoice,
    receipt_number: tax.receiptNumber,
  };
}

/** The summary fields a `SaleTax` maps onto. */
function taxSummary(tax: SaleTax) {
  return {
    receiptNumber: tax.receiptNumber,
    isVatInvoice: tax.breakdown.isVatInvoice,
    vatRatePercent: tax.vatRateUsed,
    netThb: tax.breakdown.netThb,
    vatThb: tax.breakdown.vatThb,
  };
}

/**
 * The money legs of a settlement, restated as tender lines.
 *
 * Points are dropped — they are a discount, not money in anyone's hand — and the
 * cash leg carries the notes handed over rather than the amount applied, so that
 * `รับเงิน − เงินทอน` on the printed document equals the cash in the drawer.
 */
function tenderLines(
  settlement: SettlementBreakdown,
  receivedCash?: number,
): TenderLine[] {
  return settlement.legs
    .filter((leg) => leg.method !== 'points')
    .map((leg) => ({
      method: leg.method,
      amountThb: leg.amount,
      receivedThb: leg.method === 'cash' ? (receivedCash ?? leg.amount) : null,
    }));
}

function lineSummaries(priced: PricedLine[]): OrderLineSummary[] {
  return priced.map((line) => ({
    productId: line.productId,
    name: line.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    totalPrice: line.totalPrice,
  }));
}

// ---------------------------------------------------------------- POS walk-in

/**
 * A walk-in sale: paid and completed immediately, with no reservation phase.
 *
 * Stock leaves `stock_qty` directly, because nothing was ever reserved.
 */
/**
 * A discount past the shop's own limit, and who authorised it.
 *
 * Passed in rather than re-derived here, because the PIN was verified in the
 * request layer and this module has no business knowing about sessions. What it
 * does with it is the part that belongs to the transaction: record who allowed
 * the discount against the same commit that applied it.
 */
export interface OverDiscountApproval {
  approverId: string;
  limitThb: number;
}

export async function createPosSale(input: {
  cashierId: string;
  shiftId: number;
  lines: CartLine[];
  customerId: string | null;
  manualDiscountThb?: number;
  settlement: SettlementRequest;
  overDiscountApproval?: OverDiscountApproval;
  /**
   * The paid PromptPay intent this sale settles, when the customer scanned a QR.
   *
   * Optional because a cash sale has none. When it is present the intent is
   * consumed inside this same transaction, which is what makes the two records
   * agree: there is no state in which the customer's money was recorded and the
   * bill it paid for was rolled back, or the reverse.
   */
  intentRef?: string;
}): Promise<OrderSummary> {
  return prisma.$transaction(async (tx) => {
    const priced = await priceCart(tx, input.lines);
    const subtotal = sumThb(priced.map((line) => line.totalPrice));
    const manualDiscount = roundThb(input.manualDiscountThb ?? 0);

    if (manualDiscount < 0 || manualDiscount > subtotal) {
      throw new ValidationError('Discount must be between 0 and the order subtotal');
    }

    const amountDueBeforePoints = roundThb(subtotal - manualDiscount);
    const balance = await customerPointsBalance(tx, input.customerId);

    const settlement = buildSettlement({
      amountDueThb: amountDueBeforePoints,
      request: input.settlement,
      customerPointsBalance: balance,
    });

    const discountTotal = roundThb(manualDiscount + settlement.discountThb);
    const finalAmount = roundThb(subtotal - discountTotal);
    // SRS §5.1: points are earned on the net cash/PromptPay actually collected.
    const earned = input.customerId ? computePointsEarned(settlement.paidAmountThb) : 0;
    const orderNumber = await nextOrderNumber(tx);
    /*
     * Tax is resolved before any stock moves. Allocating the receipt number
     * takes the shop row's lock, and taking it before the product rows gives
     * every sale the same lock order — so two registers cannot deadlock against
     * each other, one holding the shop row while it waits for a product the
     * other holds.
     */
    const tax = await resolveSaleTax(tx, finalAmount, new Date());

    const order = await tx.orders.create({
      data: {
        order_number: orderNumber,
        order_type: 'pos_walkin',
        status: 'completed',
        customer_id: input.customerId,
        cashier_id: input.cashierId,
        subtotal_amount: subtotal,
        discount_amount: discountTotal,
        final_amount: finalAmount,
        ...taxColumns(tax),
        points_earned: earned,
        points_redeemed: settlement.pointsRedeemed,
        completed_at: new Date(),
      },
    });

    await tx.order_items.createMany({
      data: priced.map((line) => ({
        order_id: order.id,
        product_id: line.productId,
        unit_price: line.unitPrice,
        unit_cost: line.unitCost,
        quantity: line.quantity,
        total_price: line.totalPrice,
      })),
    });

    for (const line of priced) {
      const balanceAfter = await sellFromStock(tx, {
        productId: line.productId,
        qty: line.quantity,
        productName: line.name,
      });
      await recordStockMovement(tx, {
        productId: line.productId,
        userId: input.cashierId,
        movementType: 'pos_sale',
        qtyChanged: -line.quantity,
        balanceAfter: balanceAfter.stock_qty,
        note: `POS sale ${orderNumber}`,
      });
    }

    await tx.payments.createMany({
      data: settlement.legs.map((leg) => ({
        order_id: order.id,
        shift_id: leg.method === 'points' ? null : input.shiftId,
        method: leg.method,
        amount: leg.amount,
        received_amount: leg.method === 'cash' ? (input.settlement.receivedCash ?? leg.amount) : null,
        change_amount: leg.method === 'cash' ? settlement.changeThb : null,
      })),
    });

    // Consumed inside the transaction, and before anything else is written: a
    // second submission of the same intent has to fail here rather than after the
    // stock has left.
    if (input.intentRef) {
      await consumeIntent(tx, { ref: input.intentRef, orderId: order.id });
    }

    /*
     * Written inside the sale's own transaction, so the trail can never record a
     * discount that the rollback then erased. `target_id` is the order, so the
     * row is reachable from the sale it belongs to rather than only from the
     * discount amount that happens to be in `detail`.
     */
    if (input.overDiscountApproval) {
      await recordAudit(
        {
          action: 'over_discount',
          actorUserId: input.cashierId,
          authorizedByUserId: input.overDiscountApproval.approverId,
          targetType: 'order',
          targetId: order.id,
          shiftId: input.shiftId,
          detail: {
            orderNumber,
            discountThb: manualDiscount,
            limitThb: input.overDiscountApproval.limitThb,
            totalDiscountThb: discountTotal,
          },
        },
        tx,
      );
    }

    if (input.customerId) {
      if (settlement.pointsRedeemed > 0) {
        await applyPointChange(tx, {
          userId: input.customerId,
          delta: -settlement.pointsRedeemed,
          orderId: order.id,
          description: `Redeemed on order ${orderNumber}`,
        });
      }
      if (earned > 0) {
        await applyPointChange(tx, {
          userId: input.customerId,
          delta: earned,
          orderId: order.id,
          description: `Earned on order ${orderNumber}`,
        });
      }
    }

    return {
      orderId: order.id,
      orderNumber,
      status: 'completed' as OrderStatus,
      subtotalThb: subtotal,
      discountThb: discountTotal,
      finalAmountThb: finalAmount,
      paidThb: settlement.paidAmountThb,
      changeThb: settlement.changeThb,
      tenders: tenderLines(settlement, input.settlement.receivedCash),
      pointsEarned: earned,
      pointsRedeemed: settlement.pointsRedeemed,
      lines: lineSummaries(priced),
      ...taxSummary(tax),
    };
  }, TRANSACTION_OPTIONS);
}

// ---------------------------------------------------------- Phase 1: pending

/**
 * A customer places a pre-order.
 *
 * Stock moves from available into `reserved_qty` atomically, so the item is
 * still physically on the shelf but can no longer be sold to anyone else — and
 * cannot be oversold if two customers reserve the last unit at the same time.
 */
export async function placePreOrder(input: {
  customerId: string;
  lines: CartLine[];
}): Promise<{
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  subtotalThb: number;
  confirmDeadline: Date;
}> {
  return prisma.$transaction(async (tx) => {
    const priced = await priceCart(tx, input.lines);
    const subtotal = sumThb(priced.map((line) => line.totalPrice));
    const orderNumber = await nextOrderNumber(tx);

    const order = await tx.orders.create({
      data: {
        order_number: orderNumber,
        order_type: 'preorder',
        status: 'pending',
        customer_id: input.customerId,
        subtotal_amount: subtotal,
        discount_amount: 0,
        final_amount: subtotal,
        /*
         * Nothing is taxed until the order is actually paid for at handover, so
         * the taxable base equals the total and the VAT line is zero for now.
         * Stating both explicitly is also what satisfies the order's VAT
         * reconstruction constraint while the order sits in Phase 1.
         */
        net_amount: subtotal,
        vat_amount: 0,
      },
    });

    // Reserve first: if any line is short, the whole order aborts and no order
    // row survives, so a failed reservation leaves nothing behind.
    for (const line of priced) {
      const balanceAfter = await reserveStock(tx, {
        productId: line.productId,
        qty: line.quantity,
        productName: line.name,
      });
      await recordStockMovement(tx, {
        productId: line.productId,
        userId: input.customerId,
        movementType: 'preorder_reserve',
        qtyChanged: line.quantity,
        balanceAfter: balanceAfter.stock_qty,
        note: `Reserved for pre-order ${orderNumber}`,
      });
    }

    await tx.order_items.createMany({
      data: priced.map((line) => ({
        order_id: order.id,
        product_id: line.productId,
        unit_price: line.unitPrice,
        unit_cost: line.unitCost,
        quantity: line.quantity,
        total_price: line.totalPrice,
      })),
    });

    /*
     * SRS §3 Phase 1, the half that was missing: the board chimes, and the shop's
     * own phone gets the message. A counter away from the screen is the normal case
     * in a small shop, and until now it heard nothing at all.
     */
    const customer = await tx.users.findUnique({
      where: { id: input.customerId },
      select: { full_name: true },
    });
    await enqueueNotification(
      tx,
      planPreOrderPlacedNotification(
        {
          orderId: order.id,
          orderNumber,
          customerName: customer?.full_name ?? null,
          itemCount: priced.length,
          totalThb: subtotal,
        },
        readNotifyConfig(),
      ),
    );

    return {
      orderId: order.id,
      orderNumber,
      status: 'pending' as OrderStatus,
      subtotalThb: subtotal,
      confirmDeadline: new Date(Date.now() + confirmTimeoutMinutes() * 60_000),
    };
  }, TRANSACTION_OPTIONS);
}

/** Every order item still holding stock, for release on cancel/expire. */
async function itemsHoldingStock(db: Db, orderId: string) {
  return db.order_items.findMany({
    where: { order_id: orderId },
    select: { id: true, product_id: true, quantity: true, product: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });
}

// -------------------------------------------------------- Phase 2: confirmed

/**
 * Staff accept the order, optionally dropping lines they cannot fulfil.
 *
 * SRS §3 Phase 2 partial confirmation: a broken item is removed, the totals are
 * recomputed, and its reserved stock is released immediately.
 */
export async function confirmOrder(input: {
  orderId: string;
  employeeId: string;
  removeItemIds?: string[];
}): Promise<{ orderId: string; status: OrderStatus; finalAmountThb: number }> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!canTransition(locked.status, 'confirm')) {
      throw new ConflictError(
        `Order ${input.orderId} is ${locked.status} and can no longer be confirmed`,
        'INVALID_TRANSITION',
      );
    }

    const removeIds = new Set(input.removeItemIds ?? []);
    if (removeIds.size > 0) {
      const items = await tx.order_items.findMany({ where: { order_id: input.orderId } });
      for (const item of items) {
        if (!removeIds.has(String(item.id))) {
          continue;
        }
        const balanceAfter = await releaseReservedStock(tx, {
          productId: item.product_id,
          qty: item.quantity,
        });
        await recordStockMovement(tx, {
          productId: item.product_id,
          userId: input.employeeId,
          movementType: 'preorder_cancel',
          qtyChanged: -item.quantity,
          balanceAfter: balanceAfter.stock_qty,
          note: 'Removed during confirmation',
        });
        await tx.order_items.delete({ where: { id: item.id } });
      }
    }

    const remaining = await tx.order_items.aggregate({
      where: { order_id: input.orderId },
      _sum: { total_price: true },
      _count: { _all: true },
    });

    if (remaining._count._all === 0) {
      throw new ConflictError(
        'Every item was removed; cancel the order instead of confirming an empty one',
        'EMPTY_ORDER',
      );
    }

    const subtotal = fromDecimal(remaining._sum.total_price ?? 0);
    const finalAmount = roundThb(subtotal);

    await tx.orders.update({
      where: { id: input.orderId },
      data: {
        status: 'confirmed',
        confirmed_at: new Date(),
        cashier_id: input.employeeId,
        subtotal_amount: subtotal,
        final_amount: finalAmount,
        // Partial confirmation removes lines, so the total — and therefore the
        // taxable base — has to move with it. Still no tax line: the sale has
        // not happened yet.
        net_amount: finalAmount,
        vat_amount: 0,
      },
    });

    return { orderId: input.orderId, status: 'confirmed' as OrderStatus, finalAmountThb: finalAmount };
  }, TRANSACTION_OPTIONS);
}

// ---------------------------------------------------- Phase 3: ready pickup

/** Staff pack the order; the customer receives a PIN and a hold deadline. */
export async function markOrderReady(input: {
  orderId: string;
  employeeId: string;
}): Promise<{ pickupPin: string; pickupExpiresAt: Date }> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!canTransition(locked.status, 'mark_ready')) {
      throw new ConflictError(
        `Order ${input.orderId} is ${locked.status}; only a confirmed order can be marked ready`,
        'INVALID_TRANSITION',
      );
    }

    const pickupPin = await allocatePickupPin(tx);
    const pickupExpiresAt = new Date(Date.now() + pickupHoldHours() * 60 * 60 * 1000);

    await tx.orders.update({
      where: { id: input.orderId },
      data: {
        status: 'ready_for_pickup',
        ready_at: new Date(),
        pickup_pin: pickupPin,
        pickup_expires_at: pickupExpiresAt,
        cashier_id: input.employeeId,
      },
    });

    /*
     * SRS §3 Phase 3: the customer is told, on whatever channel the shop
     * configured. Written with the status change rather than posted after it, and
     * the planner refuses to put the code on a channel that cannot address the
     * customer — see `planOrderReadyNotification`.
     */
    const order = await tx.orders.findUniqueOrThrow({
      where: { id: input.orderId },
      select: { order_number: true, customer: { select: { phone: true } } },
    });
    await enqueueNotification(
      tx,
      planOrderReadyNotification(
        {
          orderId: input.orderId,
          orderNumber: order.order_number,
          pickupPin,
          holdUntil: pickupExpiresAt,
          customerPhone: order.customer?.phone ?? null,
        },
        readNotifyConfig(),
      ),
    );

    return { pickupPin, pickupExpiresAt };
  }, TRANSACTION_OPTIONS);
}

// ------------------------------------------------------- Phase 4: completed

/**
 * Handover and settlement.
 *
 * This is the moment the reservation becomes a sale: `stock_qty` and
 * `reserved_qty` both drop, the customer's points are redeemed and awarded, and
 * the payment legs are written against the open drawer.
 */
export async function completeOrder(input: {
  orderId: string;
  employeeId: string;
  shiftId: number;
  settlement: SettlementRequest;
}): Promise<OrderSummary> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!canTransition(locked.status, 'complete')) {
      throw new ConflictError(
        `Order ${input.orderId} is ${locked.status}; only a packed order can be collected`,
        'INVALID_TRANSITION',
      );
    }

    const order = await tx.orders.findUniqueOrThrow({
      where: { id: input.orderId },
      include: { items: { include: { product: { select: { name: true } } } } },
    });

    const amountDue = fromDecimal(order.final_amount);
    const balance = await customerPointsBalance(tx, order.customer_id);

    const settlement = buildSettlement({
      amountDueThb: amountDue,
      request: input.settlement,
      customerPointsBalance: balance,
    });

    const discountTotal = roundThb(fromDecimal(order.discount_amount) + settlement.discountThb);
    const finalAmount = roundThb(amountDue - settlement.discountThb);
    const earned = order.customer_id ? computePointsEarned(settlement.paidAmountThb) : 0;
    const tax = await resolveSaleTax(tx, finalAmount, new Date());

    for (const item of order.items) {
      const balanceAfter = await commitReservedStock(tx, {
        productId: item.product_id,
        qty: item.quantity,
      });
      await recordStockMovement(tx, {
        productId: item.product_id,
        userId: input.employeeId,
        movementType: 'pos_sale',
        qtyChanged: -item.quantity,
        balanceAfter: balanceAfter.stock_qty,
        note: `Pre-order ${order.order_number} collected`,
      });
    }

    await tx.payments.createMany({
      data: settlement.legs.map((leg) => ({
        order_id: order.id,
        shift_id: leg.method === 'points' ? null : input.shiftId,
        method: leg.method,
        amount: leg.amount,
        received_amount: leg.method === 'cash' ? (input.settlement.receivedCash ?? leg.amount) : null,
        change_amount: leg.method === 'cash' ? settlement.changeThb : null,
      })),
    });

    if (order.customer_id) {
      if (settlement.pointsRedeemed > 0) {
        await applyPointChange(tx, {
          userId: order.customer_id,
          delta: -settlement.pointsRedeemed,
          orderId: order.id,
          description: `Redeemed on order ${order.order_number}`,
        });
      }
      if (earned > 0) {
        await applyPointChange(tx, {
          userId: order.customer_id,
          delta: earned,
          orderId: order.id,
          description: `Earned on order ${order.order_number}`,
        });
      }
    }

    await tx.orders.update({
      where: { id: order.id },
      data: {
        status: 'completed',
        completed_at: new Date(),
        cashier_id: input.employeeId,
        discount_amount: discountTotal,
        final_amount: finalAmount,
        ...taxColumns(tax),
        points_earned: earned,
        points_redeemed: settlement.pointsRedeemed,
      },
    });

    return {
      orderId: order.id,
      orderNumber: order.order_number,
      status: 'completed' as OrderStatus,
      subtotalThb: fromDecimal(order.subtotal_amount),
      discountThb: discountTotal,
      finalAmountThb: finalAmount,
      paidThb: settlement.paidAmountThb,
      changeThb: settlement.changeThb,
      tenders: tenderLines(settlement, input.settlement.receivedCash),
      pointsEarned: earned,
      pointsRedeemed: settlement.pointsRedeemed,
      lines: order.items.map((item) => ({
        productId: item.product_id,
        name: item.product.name,
        quantity: item.quantity,
        unitPrice: fromDecimal(item.unit_price),
        totalPrice: fromDecimal(item.total_price),
      })),
      ...taxSummary(tax),
    };
  }, TRANSACTION_OPTIONS);
}

// ------------------------------------------------------------- cancellation

/**
 * Cancels an order at any live phase and returns its stock.
 *
 * The same path serves the Phase 1 timeout, a Phase 2 out-of-stock, and a
 * Phase 3 no-show, which is why the reason is recorded rather than inferred.
 */
export async function cancelOrder(input: {
  orderId: string;
  actorId: string;
  reason: string;
  /** Set when a supervisor's PIN was required — a staff cancellation, not a
   *  member withdrawing their own pre-order. */
  authorizedByUserId?: string | null;
}): Promise<{ orderId: string; status: OrderStatus; releasedLines: number }> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrder(tx, input.orderId);
    if (!canTransition(locked.status, 'cancel')) {
      throw new ConflictError(
        `Order ${input.orderId} is ${locked.status} and cannot be cancelled`,
        'INVALID_TRANSITION',
      );
    }

    const items = await itemsHoldingStock(tx, input.orderId);

    for (const item of items) {
      const balanceAfter = await releaseReservedStock(tx, {
        productId: item.product_id,
        qty: item.quantity,
      });
      await recordStockMovement(tx, {
        productId: item.product_id,
        userId: input.actorId,
        movementType: 'preorder_cancel',
        qtyChanged: -item.quantity,
        balanceAfter: balanceAfter.stock_qty,
        note: `Cancelled: ${input.reason}`,
      });
    }

    const cancelled = await tx.orders.update({
      where: { id: input.orderId },
      data: {
        status: 'cancelled',
        cancelled_at: new Date(),
        cancel_reason: input.reason,
      },
      select: { order_number: true },
    });

    // Only a staff cancellation needed a PIN, so only that one is an audited
    // void. A member withdrawing their own pre-order is not an event the shop
    // has to account for, and logging every one would drown the ones that are.
    if (input.authorizedByUserId) {
      await recordAudit(
        {
          action: 'void_order',
          actorUserId: input.actorId,
          authorizedByUserId: input.authorizedByUserId,
          targetType: 'order',
          targetId: input.orderId,
          detail: {
            orderNumber: cancelled.order_number,
            reason: input.reason,
            releasedLines: items.length,
          },
        },
        tx,
      );
    }

    return {
      orderId: input.orderId,
      status: 'cancelled' as OrderStatus,
      releasedLines: items.length,
    };
  }, TRANSACTION_OPTIONS);
}

// ------------------------------------------------------------ expiry sweeper

/**
 * Expires Phase 1 orders that staff never confirmed — SRS §3 Phase 1.
 *
 * Runs inside a transaction holding a transaction-scoped advisory lock, so if a
 * second instance of the app is running, only one of them sweeps. The lock is
 * released automatically when the transaction ends, which matters because
 * connection pooling means a session-scoped lock could be taken on one
 * connection and released on another.
 */
export async function expireStalePendingOrders(
  now: Date = new Date(),
): Promise<{ expired: number; orderIds: string[] }> {
  const cutoff = new Date(now.getTime() - confirmTimeoutMinutes() * 60_000);

  return prisma.$transaction(async (tx) => {
    const lock = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext('pos:preorder-expiry-sweeper')) AS locked
    `;
    if (!lock[0]?.locked) {
      return { expired: 0, orderIds: [] };
    }

    const stale = await tx.orders.findMany({
      where: { status: 'pending', created_at: { lt: cutoff } },
      select: { id: true, order_number: true },
      orderBy: { created_at: 'asc' },
      take: 200,
    });

    const orderIds: string[] = [];

    for (const order of stale) {
      const items = await itemsHoldingStock(tx, order.id);
      for (const item of items) {
        const balanceAfter = await releaseReservedStock(tx, {
          productId: item.product_id,
          qty: item.quantity,
        });
        await recordStockMovement(tx, {
          productId: item.product_id,
          userId: SYSTEM_USER_ID,
          movementType: 'preorder_cancel',
          qtyChanged: -item.quantity,
          balanceAfter: balanceAfter.stock_qty,
          note: `Auto-expired: ${order.order_number} was not confirmed within ${confirmTimeoutMinutes()} minutes`,
        });
      }

      await tx.orders.update({
        where: { id: order.id },
        data: {
          status: 'cancelled',
          cancelled_at: now,
          cancel_reason: `Expired: not confirmed within ${confirmTimeoutMinutes()} minutes`,
        },
      });

      orderIds.push(order.id);
    }

    return { expired: orderIds.length, orderIds };
  }, TRANSACTION_OPTIONS);
}

// ------------------------------------------------------------- handover read

/**
 * Finds a packed order by PIN, order id, or the customer's phone number.
 *
 * At least one identifier is required: without this guard an unqualified call
 * would return whichever order happened to be packed most recently, which at a
 * handover counter is a stock mix-up waiting to happen.
 */
export async function findOrderForHandover(input: {
  pin?: string;
  orderId?: string;
  phone?: string;
  /** A scanned handover code; resolves to the order it was issued for. */
  pickupToken?: string;
}) {
  if (!input.pin && !input.orderId && !input.phone && !input.pickupToken) {
    throw new ValidationError(
      'Look up a pre-order by its pickup PIN, QR code, order id, or the registered phone number',
    );
  }

  /*
   * A scanned code becomes an order id and then takes exactly the same road as one
   * typed in by hand — including the `ready_for_pickup` filter below. That is the
   * point: the code decides *which* parcel, and the status decides whether there is
   * a parcel to hand over at all. A code for an order already collected finds
   * nothing here, just as its PIN would.
   */
  const orderId =
    input.orderId ??
    (input.pickupToken ? (await verifyPickupToken(input.pickupToken)).orderId : undefined);

  if (orderId) {
    const byId = await prisma.orders.findFirst({
      where: { id: orderId, status: 'ready_for_pickup' },
      include: {
        items: { include: { product: { select: { name: true, image_url: true } } } },
        customer: true,
      },
    });
    if (byId) {
      return byId;
    }
  }

  return prisma.orders.findFirst({
    where: {
      status: 'ready_for_pickup',
      ...(input.pin ? { pickup_pin: input.pin } : {}),
      ...(input.phone ? { customer: { phone: input.phone } } : {}),
    },
    include: {
      items: { include: { product: { select: { name: true, image_url: true } } } },
      customer: true,
    },
    orderBy: { ready_at: 'desc' },
  });
}
