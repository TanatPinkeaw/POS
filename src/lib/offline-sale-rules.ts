/**
 * May this basket be closed with no connection? — ADR 0019.
 *
 * The till's decision, pure, so it can be tested without a server, a browser or a
 * tablet sitting in a shop. What it answers is *permission and numbering*, not money:
 * the totals, the VAT split and the change come from the same pure modules the online
 * sale uses (`vat.ts`, `money.ts`, `tender.ts`), because an offline slip and an online
 * one have to be the same arithmetic in two places or they are two shops.
 *
 * Three properties this module exists to hold:
 *
 * 1. **A refused sale burns no number.** Every reason to say no is collected before
 *    any block is spent, so a basket that is turned away leaves the series exactly
 *    where it was — the same guarantee `credit-notes.ts` makes about a refused
 *    refund, for the same reason: a number is a document, and a burned one is a hole
 *    somebody has to explain.
 * 2. **The numbers come back with the decision.** The caller persists what it is
 *    handed instead of asking for "the next number" itself, so there is one place
 *    that knows which number is next.
 * 3. **Everything wrong is said at once.** A queue of refusals rather than the first
 *    one, because a cashier at a counter fixes a basket, not a stack trace.
 */
import { bangkokDateString, bangkokParts } from './bangkok-time';
import { ValidationError } from './errors';
import { formatThb, roundThb, sumThb } from './money';
import {
  blockForDay,
  nextValue,
  remaining,
  replaceBlock,
  spend,
  type NumberBlock,
} from './number-block';
import { formatReceiptNumber } from './shop-view';
import { computeVat } from './vat';

/**
 * When the till warns that its numbers are nearly gone.
 *
 * Ten, not one: the warning is only useful with enough room left to do something
 * about it, and a shop's last ten bills are a few minutes on a busy afternoon.
 */
export const LOW_NUMBERS_WARNING = 10;

/** One product as the device holds it. */
export interface OfflineCatalogueEntry {
  readonly productId: string;
  readonly name: string;
  /** The price the device may charge. Taken from the cached catalogue, never typed. */
  readonly priceThb: number;
  /** `stock_qty − reserved_qty` as of the last sync — what was sellable then. */
  readonly available: number;
  /** The quantity this shop keeps back from offline selling (ADR 0019 decision 3). */
  readonly safetyQty: number;
  readonly isActive: boolean;
}

export interface OfflineBasketLine {
  readonly productId: string;
  readonly quantity: number;
}

/**
 * Anything that has lines on it — a bill queued on the device, and the basket being
 * rung up now, are tallied by the same rule.
 */
export interface OfflineSaleLines {
  readonly lines: readonly OfflineBasketLine[];
}

export interface OfflineBasket {
  readonly lines: readonly OfflineBasketLine[];
  /** Cash is the only tender that means anything with no network. */
  readonly tender: 'cash' | 'promptpay' | 'mixed';
  readonly memberAttached: boolean;
  readonly pointsRedeemed: number;
  readonly discountThb: number;
}

export interface OfflineSaleContext {
  /** The device's clock. The Bangkok day and year are read from it, and nothing else. */
  readonly at: Date;
  /** Whether a drawer is already open. Offline, one cannot be opened. */
  readonly shiftOpen: boolean;
  readonly supervisorDiscountLimitThb: number;
  readonly isVatRegistered: boolean;
  /** The rate the shop last published, and whether its prices already carry it. */
  readonly vatRatePercent: number;
  readonly pricesIncludeVat: boolean;
  readonly receiptPrefix: string;
  readonly catalogue: readonly OfflineCatalogueEntry[];
  /**
   * The call-number blocks the device is holding — today's and tomorrow's, plus any
   * leftover it has not reported.
   */
  readonly callBlocks: readonly NumberBlock[];
  readonly receiptBlock: NumberBlock | null;
  /** Bills already closed offline that have not been sent: what the device has promised. */
  readonly pending: readonly OfflineSaleLines[];
}

/** A code for a screen to react to, and a message for the person standing at the till. */
export type OfflineRefusalCode =
  | 'no_open_shift'
  | 'cash_only'
  | 'member_unavailable'
  | 'points_unavailable'
  | 'discount_needs_supervisor'
  | 'product_unknown'
  | 'product_inactive'
  | 'stock_below_safety'
  | 'no_receipt_numbers';

/** Things the sale survives, but somebody has to know. */
export type OfflineWarningCode = 'no_call_number' | 'numbers_low';

export interface OfflineRefusal {
  readonly code: OfflineRefusalCode;
  /** What the cashier reads. Thai, and it says what to do next (rule 6). */
  readonly message: string;
  readonly productId?: string;
}

export interface OfflineWarning {
  readonly code: OfflineWarningCode;
  readonly message: string;
}

export interface OfflineSaleAllowed {
  readonly allowed: true;
  /** What to print on the slip, or null when the device has no number for today. */
  readonly callNumber: { readonly value: number; readonly day: string } | null;
  /** The tax invoice's number, or null on a shop that is not VAT-registered. */
  readonly receiptNumber: string | null;
  /** The blocks as they now stand, for the caller to persist verbatim. */
  readonly callBlocks: readonly NumberBlock[];
  readonly receiptBlock: NumberBlock | null;
  readonly warnings: readonly OfflineWarning[];
}

export interface OfflineSaleRefused {
  readonly allowed: false;
  readonly refusals: readonly OfflineRefusal[];
}

export type OfflineSaleDecision = OfflineSaleAllowed | OfflineSaleRefused;

/** How much of each product the unsent bills have already promised. */
export function tallyOfflineSales(
  pending: readonly OfflineSaleLines[],
): Map<string, number> {
  const tallied = new Map<string, number>();
  for (const bill of pending) {
    for (const line of bill.lines) {
      tallied.set(line.productId, (tallied.get(line.productId) ?? 0) + line.quantity);
    }
  }
  return tallied;
}

/**
 * What may still be sold of this product with no connection.
 *
 * The arithmetic the shop's promise rests on: what the snapshot held, minus what the
 * shop keeps back, minus what this device has already promised offline. It is
 * exported because the till shows it — a cashier who can see "เหลือ 3" stops
 * promising the fourth instead of discovering it at the counter.
 */
export function offlineSellableQty(
  entry: OfflineCatalogueEntry,
  soldOffline: ReadonlyMap<string, number>,
): number {
  return entry.available - entry.safetyQty - (soldOffline.get(entry.productId) ?? 0);
}

/** Sums a basket's lines per product, so two lines of one item are checked together. */
function quantityByProduct(lines: readonly OfflineBasketLine[]): Map<string, number> {
  const wanted = new Map<string, number>();
  for (const line of lines) {
    wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.quantity);
  }
  return wanted;
}

function assertSellableBasket(basket: OfflineBasket): void {
  if (basket.lines.length === 0) {
    throw new ValidationError('An offline sale needs at least one line');
  }
  for (const line of basket.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new ValidationError(
        `An offline sale line must be a positive whole number of units; got ${line.quantity}`,
      );
    }
  }
}

function noCallNumberWarning(): OfflineWarning {
  return {
    code: 'no_call_number',
    message:
      'ไม่มีเลขคิวในเครื่องสำหรับวันนี้ — บิลนี้จะไม่มีเลขคิว และระบบจะทำเครื่องหมายไว้ตอนซิงค์',
  };
}

function numbersLowWarning(kind: 'receipt' | 'queue', left: number): OfflineWarning {
  const what = kind === 'queue' ? 'เลขคิว' : 'เลขใบกำกับภาษี';
  return {
    code: 'numbers_low',
    message: `${what}ในเครื่องใกล้หมด (เหลือ ${left}) — ต่อเน็ตเพื่อเติมก่อนขายต่อ`,
  };
}

/**
 * Every reason this basket cannot be closed now. Nothing here touches a block.
 *
 * The order is the order a cashier would fix things in: the drawer first (nothing can
 * be sold without one), then how the customer is paying, then the customer, then the
 * money on the bill, then the goods.
 */
function collectRefusals(
  basket: OfflineBasket,
  context: OfflineSaleContext,
): OfflineRefusal[] {
  const refusals: OfflineRefusal[] = [];

  if (!context.shiftOpen) {
    refusals.push({
      code: 'no_open_shift',
      message: 'ยังไม่ได้เปิดลิ้นชัก — ออฟไลน์เปิดลิ้นชักใหม่ไม่ได้ ต้องต่อเน็ตก่อนขาย',
    });
  }

  if (basket.tender !== 'cash') {
    refusals.push({
      code: 'cash_only',
      message: 'ออฟไลน์รับได้เฉพาะเงินสด — ถ้าลูกค้าจะจ่ายพร้อมเพย์ ต้องรอเน็ตก่อน',
    });
  }

  if (basket.memberAttached) {
    refusals.push({
      code: 'member_unavailable',
      message: 'ออฟไลน์ใช้สมาชิกไม่ได้ — เอาสมาชิกออกจากบิล แล้วขายแบบไม่ผูกสมาชิก',
    });
  }

  if (basket.pointsRedeemed > 0) {
    refusals.push({
      code: 'points_unavailable',
      message: 'ออฟไลน์ใช้แต้มไม่ได้ — ปิดการใช้แต้ม แล้วขายด้วยราคาปกติ',
    });
  }

  if (basket.discountThb > context.supervisorDiscountLimitThb) {
    refusals.push({
      code: 'discount_needs_supervisor',
      message:
        `ส่วนลด ${formatThb(basket.discountThb)} เกินที่ร้านกำหนด ` +
        `(${formatThb(context.supervisorDiscountLimitThb)}) — ออฟไลน์ขออนุมัติผู้จัดการไม่ได้`,
    });
  }

  const soldOffline = tallyOfflineSales(context.pending);
  for (const [productId, wanted] of quantityByProduct(basket.lines)) {
    const entry = context.catalogue.find((candidate) => candidate.productId === productId);
    if (!entry) {
      refusals.push({
        code: 'product_unknown',
        message: 'ไม่พบสินค้านี้ในเครื่อง — ต่อเน็ตเพื่อดึงรายการสินค้าล่าสุดก่อนขาย',
        productId,
      });
      continue;
    }
    if (!entry.isActive) {
      refusals.push({
        code: 'product_inactive',
        message: `สินค้า "${entry.name}" ปิดการขายอยู่`,
        productId,
      });
      continue;
    }
    const sellable = offlineSellableQty(entry, soldOffline);
    if (sellable < wanted) {
      refusals.push({
        code: 'stock_below_safety',
        message:
          `สินค้า "${entry.name}" ขายออฟไลน์ได้อีก ${Math.max(0, sellable)} ชิ้น ` +
          `(กันสำรองไว้ ${entry.safetyQty} ชิ้น)`,
        productId,
      });
    }
  }

  /*
   * A tax invoice with no number is the one thing that must not be improvised, so the
   * block is checked here — before the sale is allowed — rather than being discovered
   * while the slip is being printed.
   */
  if (context.isVatRegistered) {
    const block = context.receiptBlock;
    /*
     * Two situations, one code, and different sentences, because "หมดแล้ว" is a lie about a
     * device that never had any: until borrowing is wired, every device is in the first case,
     * and telling a cashier their numbers ran out sends them looking for numbers that were
     * never issued.
     */
    if (block === null) {
      refusals.push({
        code: 'no_receipt_numbers',
        message: 'เครื่องนี้ยังไม่ได้เตรียมเลขใบกำกับภาษีไว้ขายออฟไลน์ — ต่อเน็ตแล้วขายตามปกติ',
      });
    } else if (nextValue(block) === null) {
      refusals.push({
        code: 'no_receipt_numbers',
        message: 'เลขใบกำกับภาษีในเครื่องหมดแล้ว — ต้องต่อเน็ตก่อนขายบิลนี้',
      });
    }
  }

  return refusals;
}

/**
 * One line of a bill that has been priced and is on paper: what was sold, how much of
 * it, and **the price the device charged**.
 *
 * The price travels with the bill rather than being looked up again later, and that is a
 * decision with a cost either way. Re-pricing it from the catalogue at sync time is
 * cheaper and wrong: the customer paid the price on the slip, and a shop that changed a
 * price during the outage would find the two disagreeing about money that has already
 * changed hands. So the device's price is the record, and the catalogue's price is kept
 * beside it as the fact to compare against (the owner's "what the till sold at", phase 4).
 */
export interface OfflineSaleLine {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPrice: number;
}

/** A priced bill, ready to print and to queue. */
export interface OfflinePricing {
  readonly lines: readonly OfflineSaleLine[];
  readonly subtotalThb: number;
  readonly discountThb: number;
  readonly finalAmountThb: number;
  /** The VAT breakdown, from the same module the online sale uses. */
  readonly netThb: number;
  readonly vatThb: number;
  readonly isVatInvoice: boolean;
  readonly vatRatePercent: number | null;
  readonly receivedThb: number;
  readonly changeThb: number;
}

/**
 * The offline slip's arithmetic.
 *
 * Deliberately the *same* two modules the online sale prices with — `vat.ts` for the tax
 * split and `money.ts` for the rounding — because an offline slip and an online one have
 * to be one shop's arithmetic in two places. A re-implementation here is how a shop ends
 * up with two VAT figures for one bill.
 *
 * Call it only after `decideOfflineSale` has allowed the basket: the prices come from the
 * cached catalogue rather than from any argument, so a caller cannot charge a price the
 * shop never published (the failure this prevents is a till sold at ฿0 after a bug or a
 * tampered page).
 *
 * Cash that does not cover the bill is a programming mistake rather than a refusal: the
 * till only offers to close a bill whose cash the cashier has entered, so reaching here
 * with less means the caller skipped the step that asks for it.
 */
export function priceOfflineSale(
  basket: OfflineBasket,
  context: OfflineSaleContext,
  receivedThb: number,
): OfflinePricing {
  const lines: OfflineSaleLine[] = basket.lines.map((line) => {
    const entry = context.catalogue.find((candidate) => candidate.productId === line.productId);
    if (!entry) {
      throw new ValidationError(`A priced offline sale names a product the device has no price for: ${line.productId}`);
    }
    return { productId: line.productId, quantity: line.quantity, unitPrice: entry.priceThb };
  });

  const subtotalThb = sumThb(lines.map((line) => roundThb(line.unitPrice * line.quantity)));
  const discountThb = roundThb(basket.discountThb);
  const finalAmountThb = roundThb(subtotalThb - discountThb);

  const breakdown = computeVat({
    amountThb: finalAmountThb,
    ratePercent: context.vatRatePercent,
    pricesIncludeVat: context.pricesIncludeVat,
    isVatRegistered: context.isVatRegistered,
  });

  const received = roundThb(receivedThb);
  if (received < finalAmountThb) {
    throw new ValidationError(
      `An offline sale was priced for less cash than it costs: ${received} < ${finalAmountThb}`,
    );
  }

  return {
    lines,
    subtotalThb,
    discountThb,
    finalAmountThb,
    netThb: breakdown.netThb,
    vatThb: breakdown.vatThb,
    isVatInvoice: breakdown.isVatInvoice,
    vatRatePercent: breakdown.isVatInvoice ? breakdown.ratePercent : null,
    receivedThb: received,
    changeThb: roundThb(received - finalAmountThb),
  };
}

/**
 * Spends a number the checks above already proved spendable.
 *
 * A block that passed `nextValue(...) !== null` cannot fail here, so this is a
 * programming mistake rather than a refusal — and it says so in English, which is the
 * rule the repository follows for anything a shop never reads (rule 6).
 */
function spendChecked(block: NumberBlock): { value: number; block: NumberBlock } {
  const taken = spend(block);
  if (!taken.ok) {
    throw new Error(`A checked number block could not be spent (${taken.reason})`);
  }
  return { value: taken.value, block: taken.block };
}

/**
 * The decision.
 *
 * Only past this point are numbers spent: `collectRefusals` is exhaustive, so an
 * allowed sale is the only path that consumes anything.
 */
export function decideOfflineSale(
  basket: OfflineBasket,
  context: OfflineSaleContext,
): OfflineSaleDecision {
  assertSellableBasket(basket);

  const refusals = collectRefusals(basket, context);
  if (refusals.length > 0) {
    return { allowed: false, refusals };
  }

  const warnings: OfflineWarning[] = [];
  const day = bangkokDateString(context.at);
  const year = bangkokParts(context.at).year;

  let callBlocks = context.callBlocks;
  let callNumber: OfflineSaleAllowed['callNumber'] = null;

  const todayBlock = blockForDay(callBlocks, day);
  if (todayBlock) {
    const taken = spendChecked(todayBlock);
    callBlocks = replaceBlock(callBlocks, taken.block);
    callNumber = { value: taken.value, day };
    const left = remaining(taken.block);
    if (left <= LOW_NUMBERS_WARNING) {
      warnings.push(numbersLowWarning('queue', left));
    }
  } else {
    /*
     * The money is the money: a device out of call numbers sells and says so. A bill
     * with no number is a ticket nobody can call, which the sync flags rather than
     * losing (ADR 0019 decision 4).
     */
    warnings.push(noCallNumberWarning());
  }

  let receiptBlock = context.receiptBlock;
  let receiptNumber: string | null = null;
  if (context.isVatRegistered && receiptBlock) {
    const taken = spendChecked(receiptBlock);
    receiptBlock = taken.block;
    receiptNumber = formatReceiptNumber(context.receiptPrefix, year, taken.value);
    const left = remaining(taken.block);
    if (left <= LOW_NUMBERS_WARNING) {
      warnings.push(numbersLowWarning('receipt', left));
    }
  }

  return { allowed: true, callNumber, receiptNumber, callBlocks, receiptBlock, warnings };
}
