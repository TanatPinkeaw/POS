/**
 * The replay — a device's queued bills reach the shop (ADR 0019 decisions 4 and 5).
 *
 * This is the other half of phase 3's device store. A bill closed with no connection sits
 * in a browser's queue with the prices it printed, the numbers it printed and the tax it
 * printed; this module is where that becomes an order, and it is the only place in the
 * codebase where **the client's own figures are the record** rather than something to be
 * recomputed. That is the whole design, and it has three consequences worth stating:
 *
 * 1. **The identity is the bill's, not the request's.** `orders.client_ref` is a UUID the
 *    device minted, unique in the database. A retry after a timeout, a batch sent twice,
 *    two servers racing on one batch — all write **one** order, because the second insert
 *    is refused by that index and this module answers with the bill that is already there.
 *    Same shape as `credit_notes (order_id, sequence)`: the API path checks, the database
 *    is what makes it true.
 * 2. **The prices are the slip's.** Re-pricing a replayed bill from today's catalogue is
 *    cheaper and wrong: the customer paid the figures on the paper in their hand. So the
 *    device's `unitPrice` is written to `order_items`, the catalogue's *current* price is
 *    compared against it and any disagreement is recorded in the audit trail — which is
 *    the owner's "what the till sold at", and the only way a device that sat in a shop for
 *    months can be caught quietly disagreeing with the shelf.
 * 3. **A shortage is accepted, not refused.** From a snapshot a device can promise more
 *    than the shelf holds, and by the time the bill arrives the goods are gone. The bill is
 *    recorded, stock is allowed to go negative (`settleReplayedSale`) and the shortage is
 *    named in the warnings and the audit row, because a record that contradicts the
 *    customer's receipt is worse than a negative number somebody can see.
 *
 * ## The order of a batch, and why it stops
 *
 * Bills are replayed in the device's own `sequence` and **the batch stops at the first
 * refusal**, rather than continuing to the bills after it. The spec's first sentence about
 * this said the rest of the queue continues; the correction is here because of what a hole
 * costs. Numbers are handed out in sequence, so a bill refused in the middle cannot be
 * stepped over: bill 3 holding receipt number 12 while bills 2 and 4 hold 11 and 13 leaves
 * a document number that exists on paper and nowhere else, and there is no way to put that
 * series back in order afterwards. Stopping keeps the invariant the whole protocol exists
 * for: every number below the reported mark is on the server as a bill, and every number
 * above it is still in the device's queue. The device keeps the refused bill, shows the
 * reason, and retries it first.
 *
 * The loans are then closed in a second pass, in their own transactions, and that
 * sequencing is deliberate rather than convenient: a report moves the shop's counter, and
 * the only safe direction for a partial outcome is *frozen*. Bills first means a crash
 * between the two leaves the series held (somebody can report it later) rather than
 * advanced past a bill that was never recorded. The report's own guard is the same rule
 * from the other side: it refuses to count past the number the bills actually reached, so
 * a device cannot talk the counter over an unrecorded document.
 */
import { recordAudit } from './audit';
import { prisma } from './db';
import { DomainError, ConflictError, NotFoundError, ValidationError } from './errors';
import { recordStockMovement, settleReplayedSale, type Db } from './inventory';
import { fromDecimal, roundThb, sumThb } from './money';
import { assertNumberBlocksOwnedBy, cancelNumberBlock, reportNumberBlock } from './number-blocks';
import { claimCallNumber, nextOrderNumber, resolveSaleTax, TRANSACTION_OPTIONS } from './orders';
import { isUniqueViolation } from './prisma-errors';
import { formatQueueNumber } from './queue-number';
import { saleDay, saleInstant } from './sale-instant';
import { loadVatSettings, lockShopRow, SHOP_ROW_ID } from './shop';
import { computeVat } from './vat';
import type { DeviceNumberClaim } from './orders';

/* -------------------------------------------------------------- the request */

export interface OfflineBillLine {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

/** The tax facts the slip was printed with. */
export interface OfflineBillTax {
  readonly isVatInvoice: boolean;
  readonly vatRatePercent: number | null;
  readonly netThb: number;
  readonly vatThb: number;
}

/** One bill out of a device's queue, exactly as it was rung up. */
export interface OfflineBillRequest {
  readonly clientRef: string;
  readonly sequence: number;
  /** ISO instant from the device's clock. */
  readonly soldAt: string;
  /** The Bangkok day the device filed it under, kept so a disagreement is visible. */
  readonly soldDay: string;
  readonly receivedThb: number;
  readonly totalThb: number;
  readonly lines: readonly OfflineBillLine[];
  readonly numbers?: {
    readonly receipt?: DeviceNumberClaim;
    readonly call?: DeviceNumberClaim;
  };
  readonly tax: OfflineBillTax;
  readonly fulfilment?: 'preparing' | 'ready' | 'collected';
}

/** Handing a loan back, or counting through it. */
export interface OfflineReportRequest {
  readonly blockId: string;
  readonly mode: 'report' | 'cancel';
  readonly lastUsed?: number;
}

/* ------------------------------------------------------------- the response */

export type OfflineBillStatus = 'recorded' | 'duplicate' | 'refused';

export interface ReplayedBill {
  readonly clientRef: string;
  readonly sequence: number;
  readonly status: OfflineBillStatus;
  /** Absent on a refusal — there is no order to name. */
  readonly orderId?: string;
  readonly orderNumber?: string;
  readonly receiptNumber?: string | null;
  readonly queueNumber?: string | null;
  /** The instant the books filed it under, and whether the device's clock was corrected. */
  readonly soldAt?: string;
  readonly clamped?: boolean;
  /** Thai, and each one is a thing somebody has to do. Empty when there is nothing. */
  readonly warnings: readonly string[];
  /** On a refusal: the typed reason, and the message the till shows. */
  readonly code?: string;
  readonly message?: string;
}

export interface ReportedBlock {
  readonly blockId: string;
  readonly status: 'reported' | 'cancelled' | 'already_closed' | 'refused';
  readonly lastUsed: number | null;
  readonly code?: string;
  readonly message?: string;
}

export interface OfflineSyncResult {
  /**
   * One entry per bill that was *attempted*, in order. A bill absent from this list was
   * never tried — the batch stopped before it — and is still the device's to keep.
   */
  readonly bills: readonly ReplayedBill[];
  readonly reports: readonly ReportedBlock[];
  /** How many bills the request carried that were not attempted. */
  readonly notAttempted: number;
}

/* ------------------------------------------------------------------- replay */

export async function syncOfflineBatch(input: {
  /** The employee signed in at the device. Every bill is attributed to them. */
  cashierId: string;
  /** The drawer the bills were sold under. */
  shiftId: number;
  bills: readonly OfflineBillRequest[];
  reports: readonly OfflineReportRequest[];
  /** Injectable so a test can state the instant it means. */
  now?: Date;
}): Promise<OfflineSyncResult> {
  const now = input.now ?? new Date();

  /*
   * The drawer is read once for the whole batch rather than per bill, and a *closed* one is
   * a warning rather than a refusal. The refusal is not available: the money was taken
   * before the drawer was counted, and a bill that cannot be filed leaves the shop holding
   * cash with no record of it. So the bill lands where it belongs and somebody is told that
   * that day's count is now short — which is the honest version of the failure, and the one
   * a person can act on.
   */
  const shift = await prisma.cash_shifts.findUnique({
    where: { id: input.shiftId },
    select: { id: true, status: true, opened_by: true },
  });
  if (!shift) {
    throw new ConflictError(
      `ไม่พบลิ้นชัก #${input.shiftId} — เครื่องนี้อาจถูกล้างข้อมูล ต้องเปิดลิ้นชักใหม่แล้วซิงค์อีกครั้ง`,
      'REPLAY_SHIFT_UNKNOWN',
    );
  }
  if (shift.opened_by !== input.cashierId) throw new ConflictError('บิลนี้เป็นของลิ้นชักผู้ใช้อื่น — เข้าระบบด้วยบัญชีเดิม', 'REPLAY_WRONG_CASHIER');
  const drawerCounted = shift.status !== 'open';

  const ordered = [...input.bills].sort((left, right) => left.sequence - right.sequence);
  const bills: ReplayedBill[] = [];

  for (const bill of ordered) {
    const result = await recordBill({
      bill,
      cashierId: input.cashierId,
      shiftId: input.shiftId,
      drawerCounted,
      now,
    });
    bills.push(result);
    if (result.status === 'refused') {
      break;
    }
  }

  const reports: ReportedBlock[] = [];
  for (const report of input.reports) {
    if (bills.some((bill) => bill.status === 'refused')) {
      reports.push({ blockId: report.blockId, status: 'refused', lastUsed: null, code: 'REPLAY_PENDING', message: 'ส่งบิลที่ถูกปฏิเสธให้ครบก่อนคืนชุดเลข' });
    } else reports.push(await applyReport({ report, userId: input.cashierId }));
  }

  return { bills, reports, notAttempted: ordered.length - bills.length };
}

/* ---------------------------------------------------------------- one bill */

/**
 * Records one bill, in its own transaction.
 *
 * Its own transaction rather than one for the batch, because the batch's unit of success is
 * a bill: the device removes exactly the bills this answered for, and a transaction that
 * covered the whole queue could only be all-or-nothing, which cannot express "the first
 * three landed and the fourth is refused".
 *
 * A `DomainError` here is a *judgement about this bill* — a number the loan never lent, a
 * product that no longer exists, a total that does not add up — and every one of them has
 * the same handling: keep the bill, tell the device why, stop. Only an error that is not a
 * domain error is a bug, and it is left to become a 500 (`withApi`) rather than being
 * dressed up as a refusal the till would retry forever.
 */
async function recordBill(input: {
  bill: OfflineBillRequest;
  cashierId: string;
  shiftId: number;
  drawerCounted: boolean;
  now: Date;
}): Promise<ReplayedBill> {
  const { bill } = input;

  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize before inspecting identity, including non-VAT bills with no number claim.
      await lockShopRow(tx);
      const existing = await findRecordedBill(tx, bill.clientRef);
      if (existing) {
        await assertSameBill(tx, existing.id, bill, input.cashierId, input.shiftId);
        // A lost acknowledgement can leave a ticket local while the bar advances it.
        // Merge forward only, never resurrect a collected ticket on an older retry.
        if (bill.fulfilment) {
          const ranks = { preparing: 0, ready: 1, collected: 2 };
          const order = await tx.orders.findUniqueOrThrow({ where: { id: existing.id }, select: { fulfilment: true } });
          if (order.fulfilment && ranks[bill.fulfilment] > ranks[order.fulfilment]) {
            await tx.orders.update({ where: { id: existing.id }, data: { fulfilment: bill.fulfilment, ...(bill.fulfilment === 'ready' ? { ready_at: input.now } : {}) } });
          }
        }
        return duplicateOf(existing, bill);
      }

      const filed = saleInstant({ now: input.now, deviceInstant: new Date(bill.soldAt) });
      const at = filed.at;
      const warnings: string[] = [];
      if (filed.clamped) {
        warnings.push(
          'เวลาของเครื่องล้ำหน้ากว่าเซิร์ฟเวอร์ — บิลนี้ถูกบันทึกเป็นเวลาปัจจุบัน ไม่ใช่วันในอนาคต',
        );
      }
      const day = saleDay(at);
      if (bill.soldDay !== day) {
        warnings.push(
          `เครื่องบันทึกว่าเป็นวันที่ ${bill.soldDay} แต่เซิร์ฟเวอร์จัดบิลนี้เป็นวันที่ ${day}`,
        );
      }
      if (input.drawerCounted) {
        warnings.push(
          `ลิ้นชัก #${input.shiftId} ปิดไปแล้ว — บิลนี้ถูกบันทึกย้อนหลัง ยอดนับของลิ้นชักนั้นจะขาดไป ต้องให้ผู้ดูแลตรวจ`,
        );
      }

      const priced = await priceReplayedCart(tx, bill);

      const subtotal = sumThb(priced.map((line) => line.totalPrice));
      const finalAmount = roundThb(bill.totalThb);
      const discount = roundThb(subtotal - finalAmount);

      /*
       * The bill has to add up before anything is written, and the three checks below are
       * the database's own constraints restated so the device hears a Thai sentence with a
       * next step instead of a 500 from a refused CHECK:
       *   * `net + vat = final` on `orders`;
       *   * `amount > 0` on `payments` (a bill the customer paid nothing for cannot be
       *     recorded as a cash leg, and an offline sale that comes to zero is a basket the
       *     till should not have closed);
       *   * a negative discount, which is lines that do not sum to what was charged.
       */
      const discountLimit = Number((await tx.shops.findUniqueOrThrow({ where: { id: SHOP_ROW_ID } })).supervisor_discount_limit_thb);
      if (bill.receivedThb < finalAmount) {
        throw new ConflictError('เงินสดที่รับมาน้อยกว่ายอดบิล — ให้ผู้ดูแลตรวจบิลที่เครื่อง', 'REPLAY_CASH_SHORT');
      }
      if (discount > discountLimit) {
        throw new ConflictError('ส่วนลดในบิลเกินวงเงินที่ร้านอนุมัติได้ — ให้ผู้ดูแลตรวจบิลที่เครื่อง', 'REPLAY_DISCOUNT_OVER_LIMIT');
      }
      if (discount < 0) {
        throw new ConflictError(
          'ยอดรวมของบิลนี้ไม่ตรงกับราคาของแต่ละรายการ — เครื่องอาจเก็บข้อมูลเสีย ต้องให้ผู้ดูแลตรวจที่เครื่อง',
          'REPLAY_BILL_MALFORMED',
        );
      }
      if (finalAmount <= 0) {
        throw new ConflictError(
          'บิลออฟไลน์ที่ยอดเป็นศูนย์บันทึกไม่ได้ — ต้องให้ผู้ดูแลตรวจบิลนี้ที่เครื่อง',
          'REPLAY_BILL_MALFORMED',
        );
      }
      if (roundThb(bill.tax.netThb + bill.tax.vatThb) !== finalAmount) {
        throw new ConflictError(
          'ยอดภาษีบนใบกำกับไม่ตรงกับยอดบิล — ต้องให้ผู้ดูแลตรวจบิลนี้ที่เครื่อง',
          'REPLAY_BILL_MALFORMED',
        );
      }

      /*
       * The tax document is decided before it is written, and the decision is checked
       * against what the slip says rather than recomputed over it. `resolveSaleTax` is the
       * same function an online sale uses, so the receipt number is claimed from the loan by
       * the same rule and the "a shop that stopped issuing tax invoices" refusal is the same
       * one — one implementation, two callers.
       */
      const settings = await loadVatSettings(tx);
      if (issuesVatInvoice(settings, finalAmount) !== bill.tax.isVatInvoice) {
        throw new ConflictError(
          'การตั้งค่าภาษีของร้านเปลี่ยนไปหลังเครื่องขายบิลนี้ — บิลนี้จึงบันทึกอัตโนมัติไม่ได้ ' +
            'ต้องให้ผู้ดูแลตรวจภาษีของร้านก่อน แล้วซิงค์เครื่องอีกครั้ง',
          'REPLAY_TAX_SETTINGS_CHANGED',
        );
      }
      if (bill.tax.isVatInvoice && !bill.numbers?.receipt) {
        throw new ConflictError('บิลใบกำกับออฟไลน์ต้องมีเลขที่พิมพ์จากชุดยืม — ให้ผู้ดูแลตรวจบิล', 'REPLAY_RECEIPT_REQUIRED');
      }
      await assertNumberBlocksOwnedBy(tx, [bill.numbers?.receipt, bill.numbers?.call], input.cashierId);
      const tax = await resolveSaleTax(tx, finalAmount, at, bill.numbers?.receipt);

      /*
       * The call number is claimed, never allocated: a bill sold offline printed a number
       * from a block the device was holding, or printed none at all because it held nothing
       * for that day. Allocating one here would put a number on a record whose slip has a
       * different one.
       */
      const call = bill.numbers?.call ? await claimCallNumber(tx, bill.numbers.call, at) : null;

      const orderNumber = await nextOrderNumber(tx);
      const order = await tx.orders.create({
          data: {
            order_number: orderNumber,
            order_type: 'pos_walkin',
            status: 'completed',
            /* The device's own identity: what makes a retried batch write one order. */
            client_ref: bill.clientRef,
            /*
             * No customer and no points. Both are refused offline (ADR 0019), so a device
             * cannot have attached one — and a replayed bill that claimed points would be
             * inventing an account's balance from a slip.
             */
            customer_id: null,
            cashier_id: input.cashierId,
            subtotal_amount: subtotal,
            discount_amount: discount,
            final_amount: finalAmount,
            /* The printed figures, not a re-derivation: this document is in a customer's hand. */
            net_amount: roundThb(bill.tax.netThb),
            vat_amount: roundThb(bill.tax.vatThb),
            vat_rate_used: bill.tax.vatRatePercent,
            is_vat_invoice: bill.tax.isVatInvoice,
            receipt_number: tax.receiptNumber,
            points_earned: 0,
            points_redeemed: 0,
            /** When the sale happened, which is what every day-bucketed read files it under. */
            completed_at: at,
            sold_at: at,
            queue_number: call?.value ?? null,
            queue_day: call?.day ?? null,
            ...(bill.fulfilment ? { fulfilment: bill.fulfilment, ...(bill.fulfilment === 'ready' ? { ready_at: at } : {}) } : {}),
            // Legacy clients omit fulfilment; prepared tills carry their local ticket state.
          },
          select: { id: true },
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

      /*
       * Stock is settled *after* the bill exists, deliberately: the goods are already in a
       * customer's hands, so the bill is the fact and the shelf is the consequence. Going
       * negative is the outcome this accepts (see `settleReplayedSale`), and every product
       * that ends up below zero is named in the warnings and in the trail.
       */
      const shortages: string[] = [];
      for (const line of priced) {
        const balance = await settleReplayedSale(tx, {
          productId: line.productId,
          qty: line.quantity,
          productName: line.name,
        });
        await recordStockMovement(tx, {
          productId: line.productId,
          userId: input.cashierId,
          movementType: 'pos_sale',
          qtyChanged: -line.quantity,
          balanceAfter: balance.stock_qty,
          note: `Offline sale ${orderNumber} (${bill.clientRef}) synced`,
        });
        if (balance.stock_qty < 0) {
          shortages.push(line.name);
        }
      }
      if (shortages.length > 0) {
        warnings.push(
          `สต็อกติดลบ ${shortages.length} รายการ (${shortages.join(', ')}) — ` +
            'ขายออฟไลน์เกินของที่นับไว้ ต้องนับของจริงแล้วปรับสต็อก',
        );
      }

      const changeThb = roundThb(bill.receivedThb - finalAmount);
      await tx.payments.create({
        data: {
          order_id: order.id,
          shift_id: input.shiftId,
          /* Cash is the only tender an offline sale can have — the device refuses the rest. */
          method: 'cash',
          amount: finalAmount,
          received_amount: bill.receivedThb,
          change_amount: changeThb,
          paid_at: at,
        },
      });

      const priceDisagreements = priced
        .filter((line) => line.unitPrice !== line.cataloguePrice)
        .map((line) => ({
          productId: line.productId,
          name: line.name,
          soldAt: line.unitPrice,
          catalogueThb: line.cataloguePrice,
        }));
      if (priceDisagreements.length > 0) {
        warnings.push(
          `ราคาที่เครื่องขายไม่ตรงกับราคาปัจจุบันของสินค้า ${priceDisagreements.length} รายการ ` +
            '— บิลนี้บันทึกตามราคาที่ขายจริง',
        );
      }

      /*
       * The trail row for the bill, which is where "recorded offline, synced at 08:12"
       * becomes a fact. It carries the three disagreements the shop may have to explain
       * later — a price the catalogue has moved past, a tax rate that changed during the
       * outage, and a drawer that had already been counted — so the answer is in the row
       * rather than in somebody's memory of the day.
       */
      await recordAudit(
        {
          action: 'offline_sale_synced',
          actorUserId: input.cashierId,
          targetType: 'order',
          targetId: order.id,
          shiftId: input.shiftId,
          detail: {
            orderNumber,
            clientRef: bill.clientRef,
            soldAt: at.toISOString(),
            soldDay: day,
            soldDayFromDevice: bill.soldDay,
            soldAtFromDevice: bill.soldAt,
            printedNumbers: { ...(bill.numbers?.receipt ? { receipt: { ...bill.numbers.receipt } } : {}), ...(bill.numbers?.call ? { call: { ...bill.numbers.call } } : {}) },
            syncedAt: input.now.toISOString(),
            clockClamped: filed.clamped,
            receiptNumber: tax.receiptNumber,
            queueNumber: call ? formatQueueNumber(call.value) : null,
            printedTaxRate: bill.tax.vatRatePercent,
            currentTaxRate: tax.breakdown.isVatInvoice ? tax.breakdown.ratePercent : null,
            drawerCounted: input.drawerCounted,
            priceDisagreements,
            shortages,
          },
        },
        tx,
      );

      return {
        clientRef: bill.clientRef,
        sequence: bill.sequence,
        status: 'recorded' as const,
        orderId: order.id,
        orderNumber,
        receiptNumber: tax.receiptNumber,
        queueNumber: call ? formatQueueNumber(call.value) : null,
        soldAt: at.toISOString(),
        clamped: filed.clamped,
        warnings,
      };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await findRecordedBill(prisma, bill.clientRef);
      if (winner) {
        await assertSameBill(prisma, winner.id, bill, input.cashierId, input.shiftId);
        return duplicateOf(winner, bill);
      }
    }
    if (error instanceof DomainError) {
      return {
        clientRef: bill.clientRef,
        sequence: bill.sequence,
        status: 'refused',
        warnings: [],
        code: error.code,
        message: error.message,
      };
    }
    throw error;
  }
}

/** A line of a replayed bill: what was sold, at what price, and what the shelf says now. */
interface ReplayedLine {
  productId: string;
  name: string;
  quantity: number;
  /** What the customer paid. The record. */
  unitPrice: number;
  /** What the catalogue charges today — compared, never substituted. */
  cataloguePrice: number;
  /**
   * What the goods cost, read now.
   *
   * The device never knew this figure and could not: it is a back-office number, and
   * carrying every product's cost into a browser so an offline bill could have one would be
   * shipping the shop's margins to a tablet. A replay is therefore costed at the price in
   * force when it arrives, which is the same figure the next stock valuation uses.
   */
  unitCost: number;
  totalPrice: number;
}

async function priceReplayedCart(db: Db, bill: OfflineBillRequest): Promise<ReplayedLine[]> {
  const products = await db.products.findMany({
    where: { id: { in: [...new Set(bill.lines.map((line) => line.productId))] } },
    select: { id: true, name: true, sale_price: true, cost_price: true },
  });
  const byId = new Map(products.map((product) => [product.id, product]));

  return bill.lines.map((line) => {
    const product = byId.get(line.productId);
    if (!product) {
      /*
       * Products are never hard-deleted (`order_items.product_id` references them), so this
       * is a device holding a bill for something the shop no longer has at all. File it as a
       * refusal with a next step rather than letting the foreign key raise a 500.
       */
      throw new ConflictError(
        'บิลนี้มีสินค้าที่ร้านไม่มีแล้ว — ต้องให้ผู้ดูแลตรวจที่เครื่องก่อนขายต่อ',
        'REPLAY_PRODUCT_UNKNOWN',
      );
    }
    return {
      productId: line.productId,
      name: product.name,
      quantity: line.quantity,
      unitPrice: roundThb(line.unitPrice),
      cataloguePrice: fromDecimal(product.sale_price as never),
      unitCost: fromDecimal(product.cost_price as never),
      totalPrice: roundThb(line.unitPrice * line.quantity),
    };
  });
}

/**
 * Whether a sale of this size would issue a tax invoice under the shop's settings *now*.
 *
 * Asked before `resolveSaleTax` rather than after, because that function allocates a
 * receipt number when a tax invoice is due — and a shop that turned VAT registration on
 * during an outage would otherwise consume a number for a document the device never
 * printed. A number spent on a slip that does not exist is exactly the hole in the series
 * this whole protocol is for.
 */
function issuesVatInvoice(
  settings: { isVatRegistered: boolean; vatRate: number; pricesIncludeVat: boolean },
  amountThb: number,
): boolean {
  return computeVat({
    amountThb,
    ratePercent: settings.vatRate,
    pricesIncludeVat: settings.pricesIncludeVat,
    isVatRegistered: settings.isVatRegistered,
  }).isVatInvoice;
}

async function assertSameBill(db: Db, id: string, bill: OfflineBillRequest, cashierId: string, shiftId: number): Promise<void> {
  const order = await db.orders.findUniqueOrThrow({ where: { id }, include: { items: true, payments: true } });
  const normalize = (lines: readonly { productId: string; quantity: number; unitPrice: number }[]) => JSON.stringify([...lines].sort((a, b) => a.productId.localeCompare(b.productId)));
  const lines = order.items.map((line) => ({ productId: line.product_id, quantity: line.quantity, unitPrice: Number(line.unit_price) }));
  /*
   * The device's own identity — the instant it sold the bill, the day it filed it under, the
   * numbers it printed — is written into the sync audit row in the same transaction as the
   * order. A missing row is therefore **not** "nothing to compare": it means this order's
   * identity record is gone, and the only safe reading of a reused client reference against
   * an order we can no longer identify is a refusal. Failing closed here is the difference
   * between a double-record guard and one that quietly stops guarding the moment its
   * identity source is absent — which is exactly the hole this check exists to close.
   */
  const audit = await db.audit_logs.findFirst({ where: { target_id: id, action: 'offline_sale_synced' }, select: { detail: true } });
  const detail = audit?.detail as { soldAtFromDevice?: string; soldDayFromDevice?: string; printedNumbers?: OfflineBillRequest['numbers'] } | null;
  if (!detail) {
    throw new ConflictError('บันทึกตัวตนของบิลนี้หายไป — ตรวจบิลเดิมในระบบก่อนส่งซ้ำ', 'REPLAY_ID_CONFLICT');
  }
  const sameNumber = (a?: DeviceNumberClaim, b?: DeviceNumberClaim) => a?.blockId === b?.blockId && a?.value === b?.value;
  const identityMismatch =
    !detail.soldAtFromDevice || new Date(detail.soldAtFromDevice).getTime() !== new Date(bill.soldAt).getTime() ||
    !detail.soldDayFromDevice || detail.soldDayFromDevice !== bill.soldDay ||
    !sameNumber(detail.printedNumbers?.receipt, bill.numbers?.receipt) ||
    !sameNumber(detail.printedNumbers?.call, bill.numbers?.call);
  if (identityMismatch ||
      order.cashier_id !== cashierId || !order.payments.some((p) => p.shift_id === shiftId) ||
      Number(order.final_amount) !== roundThb(bill.totalThb) || normalize(lines) !== normalize(bill.lines) ||
      !order.payments.some((p) => p.direction === 'sale' && p.method === 'cash' && Number(p.received_amount) === roundThb(bill.receivedThb)) ||
      order.is_vat_invoice !== bill.tax.isVatInvoice || Number(order.net_amount) !== roundThb(bill.tax.netThb) ||
      Number(order.vat_amount) !== roundThb(bill.tax.vatThb) || (order.vat_rate_used === null ? null : Number(order.vat_rate_used)) !== bill.tax.vatRatePercent ||
      order.queue_number !== (bill.numbers?.call?.value ?? null) ||
      (bill.numbers?.receipt && !order.receipt_number?.endsWith(`-${String(bill.numbers.receipt.value).padStart(6, '0')}`))) {
    throw new ConflictError('รหัสบิลนี้ถูกใช้กับข้อมูลอื่นแล้ว — ตรวจบิลเดิมก่อนส่ง', 'REPLAY_ID_CONFLICT');
  }
}

/** An order that is already recorded under this device reference. */
interface RecordedBill {
  id: string;
  order_number: string;
  receipt_number: string | null;
  queue_number: number | null;
  sold_at: Date;
}

async function findRecordedBill(db: Db, clientRef: string): Promise<RecordedBill | null> {
  return db.orders.findUnique({
    where: { client_ref: clientRef },
    select: {
      id: true,
      order_number: true,
      receipt_number: true,
      queue_number: true,
      sold_at: true,
    },
  });
}

/**
 * The answer for a bill that is already on the server.
 *
 * Reported as `duplicate` rather than as an error, and with the same fields a first send
 * returned, so a device that retried a batch cannot tell the difference between "it landed
 * while I was waiting" and "it had landed before" — and does not need to. It removes the
 * bill either way, which is the idempotency this exists for.
 */
function duplicateOf(recorded: RecordedBill, bill: OfflineBillRequest): ReplayedBill {
  return {
    clientRef: bill.clientRef,
    sequence: bill.sequence,
    status: 'duplicate',
    orderId: recorded.id,
    orderNumber: recorded.order_number,
    receiptNumber: recorded.receipt_number,
    queueNumber: recorded.queue_number === null ? null : formatQueueNumber(recorded.queue_number),
    soldAt: recorded.sold_at.toISOString(),
    clamped: false,
    warnings: [],
  };
}

/* ------------------------------------------------------------- the reports */

/**
 * Closes one loan: how far the device counted, or that it never used it.
 *
 * Both cases are idempotent by a read rather than by an error: a block already reported or
 * cancelled answers `already_closed`, because the second sync of a batch is a normal event
 * (a timeout, a retry) and not something a device should have to interpret.
 *
 * The guard that matters is the one this module adds rather than the one it reuses: a
 * device may not report *past* the number its bills reached. `reportNumberBlock` checks the
 * range and refuses a regression, but nothing below it can know how many bills actually
 * arrived — and a report that counted over an unrecorded document is the counter moving
 * past a hole.
 */
async function applyReport(input: {
  report: OfflineReportRequest;
  userId: string;
}): Promise<ReportedBlock> {
  const { report } = input;
  try {
    const row = await prisma.number_blocks.findUnique({
      where: { id: report.blockId },
      select: { last_used_number: true, reported_at: true, cancelled_at: true, opened_by: true },
    });
    if (!row) {
      throw new NotFoundError('ไม่พบชุดเลขที่ระบุ', 'Number block');
    }
    if (row.opened_by !== input.userId) throw new ConflictError('ชุดเลขเป็นของผู้ใช้อื่น — ใช้บัญชีที่ยืมชุดเลข', 'REPLAY_WRONG_CASHIER');
    if (row.reported_at !== null || row.cancelled_at !== null) {
      return { blockId: report.blockId, status: 'already_closed', lastUsed: row.last_used_number };
    }

    if (report.mode === 'cancel') {
      const cancelled = await cancelNumberBlock({ id: report.blockId, userId: input.userId });
      return { blockId: report.blockId, status: 'cancelled', lastUsed: cancelled.lastUsed };
    }

    if (report.lastUsed === undefined) {
      throw new ValidationError('A report must name the last number the device printed');
    }
    const recorded = row.last_used_number ?? 0;
    if (report.lastUsed > recorded) {
      throw new ConflictError(
        `เครื่องรายงานว่าใช้ถึงเลข ${report.lastUsed} แต่บิลที่ส่งมาถึงเลข ${recorded} เท่านั้น ` +
          '— ต้องส่งบิลที่ค้างให้ครบก่อน จึงจะปิดชุดเลขได้',
        'REPLAY_REPORT_AHEAD_OF_BILLS',
      );
    }

    const reported = await reportNumberBlock({
      id: report.blockId,
      lastUsed: report.lastUsed,
      userId: input.userId,
    });
    return { blockId: report.blockId, status: 'reported', lastUsed: reported.lastUsed };
  } catch (error) {
    if (error instanceof DomainError) {
      return {
        blockId: report.blockId,
        status: 'refused',
        lastUsed: null,
        code: error.code,
        message: error.message,
      };
    }
    throw error;
  }
}
