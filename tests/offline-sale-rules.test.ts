// Seam under test: whether a basket may be closed with no connection (ADR 0019).
//
// Pure: the decision that a shop leans on during an outage, and the one that has to
// hold "a refused sale burns no number" — a property nobody can check by clicking
// through a dropped connection.
import { describe, expect, it } from 'vitest';

import type { NumberBlock } from '@/lib/number-block';
import {
  decideOfflineSale,
  offlineSellableQty,
  tallyOfflineSales,
  type OfflineBasket,
  type OfflineCatalogueEntry,
  type OfflineSaleContext,
} from '@/lib/offline-sale-rules';

/** 2026-09-29 in Bangkok, mid-afternoon. */
const AT = new Date('2026-09-29T08:00:00.000Z');
const TODAY = '2026-09-29';
const TOMORROW = '2026-09-30';

const COFFEE: OfflineCatalogueEntry = {
  productId: 'p-coffee',
  name: 'กาแฟเย็น',
  priceThb: 45,
  available: 10,
  safetyQty: 0,
  isActive: true,
};

const CAKE: OfflineCatalogueEntry = {
  productId: 'p-cake',
  name: 'เค้กชิ้น',
  priceThb: 65,
  available: 4,
  safetyQty: 1,
  isActive: true,
};

const RETIRED: OfflineCatalogueEntry = {
  productId: 'p-old',
  name: 'ของเลิกขาย',
  priceThb: 20,
  available: 5,
  safetyQty: 0,
  isActive: false,
};

function callBlock(overrides: Partial<NumberBlock> = {}): NumberBlock {
  return { kind: 'queue', day: TODAY, from: 1, to: 100, lastUsed: null, ...overrides };
}

function vatReceiptBlock(overrides: Partial<NumberBlock> = {}): NumberBlock {
  return { kind: 'receipt', day: null, from: 500, to: 549, lastUsed: null, ...overrides };
}

function basket(overrides: Partial<OfflineBasket> = {}): OfflineBasket {
  return {
    lines: [{ productId: 'p-coffee', quantity: 1 }],
    tender: 'cash',
    memberAttached: false,
    pointsRedeemed: 0,
    discountThb: 0,
    ...overrides,
  };
}

function context(overrides: Partial<OfflineSaleContext> = {}): OfflineSaleContext {
  return {
    at: AT,
    shiftOpen: true,
    supervisorDiscountLimitThb: 50,
    isVatRegistered: true,
    receiptPrefix: 'FR',
    catalogue: [COFFEE, CAKE, RETIRED],
    callBlocks: [callBlock(), callBlock({ day: TOMORROW, from: 101, to: 200 })],
    receiptBlock: vatReceiptBlock(),
    pending: [],
    ...overrides,
  };
}

function refusalCodes(decision: ReturnType<typeof decideOfflineSale>): string[] {
  return decision.allowed ? [] : decision.refusals.map((refusal) => refusal.code);
}

describe('a cash sale with no connection', () => {
  it('is allowed, and brings its numbers back with it', () => {
    const decision = decideOfflineSale(basket(), context());

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.callNumber).toEqual({ value: 1, day: TODAY });
    expect(decision.receiptNumber).toBe('FR-2026-000500');
    // The store persists what it is handed rather than asking for the next number.
    expect(decision.callBlocks[0]?.lastUsed).toBe(1);
    expect(decision.receiptBlock?.lastUsed).toBe(500);
    expect(decision.warnings).toEqual([]);
  });

  it('takes the next number, not the first one again', () => {
    const decision = decideOfflineSale(
      basket(),
      context({ callBlocks: [callBlock({ lastUsed: 7 })], receiptBlock: vatReceiptBlock({ lastUsed: 517 }) }),
    );

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.callNumber?.value).toBe(8);
    expect(decision.receiptNumber).toBe('FR-2026-000518');
  });

  it('needs no tax invoice number on a shop that is not VAT-registered', () => {
    const decision = decideOfflineSale(basket(), context({ isVatRegistered: false, receiptBlock: null }));

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.receiptNumber).toBeNull();
  });
});

describe('a refused sale burns no number', () => {
  it('leaves both blocks exactly where they were', () => {
    const before = context({ shiftOpen: false });
    const decision = decideOfflineSale(basket(), before);

    expect(refusalCodes(decision)).toEqual(['no_open_shift']);
    // The context is what the store hands in; nothing about it may have moved.
    expect(before.callBlocks[0]?.lastUsed).toBeNull();
    expect(before.receiptBlock?.lastUsed).toBeNull();
  });

  it('leaves the numbers alone when the goods are short, not the money', () => {
    const before = context({ catalogue: [{ ...COFFEE, available: 1 }] });
    const decision = decideOfflineSale(basket({ lines: [{ productId: 'p-coffee', quantity: 2 }] }), before);

    expect(refusalCodes(decision)).toEqual(['stock_below_safety']);
    expect(before.callBlocks[0]?.lastUsed).toBeNull();
  });
});

describe('what the counter cannot do with no connection', () => {
  it('refuses anything that is not cash', () => {
    expect(refusalCodes(decideOfflineSale(basket({ tender: 'promptpay' }), context()))).toEqual([
      'cash_only',
    ]);
    expect(refusalCodes(decideOfflineSale(basket({ tender: 'mixed' }), context()))).toEqual([
      'cash_only',
    ]);
  });

  it('refuses a member, because the shop’s customer list is not on the device', () => {
    expect(refusalCodes(decideOfflineSale(basket({ memberAttached: true }), context()))).toEqual([
      'member_unavailable',
    ]);
  });

  it('refuses points', () => {
    expect(refusalCodes(decideOfflineSale(basket({ pointsRedeemed: 10 }), context()))).toEqual([
      'points_unavailable',
    ]);
  });

  it('holds a discount to the shop’s limit, because approval needs the server', () => {
    const over = decideOfflineSale(basket({ discountThb: 51 }), context());
    expect(refusalCodes(over)).toEqual(['discount_needs_supervisor']);
    if (over.allowed) return;
    expect(over.refusals[0]?.message).toContain('50.00');

    expect(decideOfflineSale(basket({ discountThb: 50 }), context()).allowed).toBe(true);
  });

  it('refuses a product the device has never heard of', () => {
    const decision = decideOfflineSale(basket({ lines: [{ productId: 'p-ghost', quantity: 1 }] }), context());

    expect(refusalCodes(decision)).toEqual(['product_unknown']);
  });

  it('refuses a product that has been taken off sale', () => {
    const decision = decideOfflineSale(basket({ lines: [{ productId: 'p-old', quantity: 1 }] }), context());

    expect(refusalCodes(decision)).toEqual(['product_inactive']);
  });

  it('refuses a tax invoice when no number is left, rather than inventing one', () => {
    const spent = vatReceiptBlock({ from: 500, to: 500, lastUsed: 500 });
    expect(refusalCodes(decideOfflineSale(basket(), context({ receiptBlock: spent })))).toEqual([
      'no_receipt_numbers',
    ]);
    expect(refusalCodes(decideOfflineSale(basket(), context({ receiptBlock: null })))).toEqual([
      'no_receipt_numbers',
    ]);
  });

  it('says everything that is wrong at once', () => {
    const decision = decideOfflineSale(
      basket({ tender: 'promptpay', memberAttached: true, pointsRedeemed: 5, discountThb: 999 }),
      context({ shiftOpen: false }),
    );

    expect(refusalCodes(decision)).toEqual([
      'no_open_shift',
      'cash_only',
      'member_unavailable',
      'points_unavailable',
      'discount_needs_supervisor',
    ]);
  });
});

describe('the safety quantity, which is the whole stock promise offline', () => {
  it('keeps the shop’s reserve out of what may be sold', () => {
    // 4 in the snapshot, 1 kept back for the counter.
    expect(offlineSellableQty(CAKE, new Map())).toBe(3);
    expect(decideOfflineSale(basket({ lines: [{ productId: 'p-cake', quantity: 3 }] }), context()).allowed).toBe(true);
    expect(refusalCodes(decideOfflineSale(basket({ lines: [{ productId: 'p-cake', quantity: 4 }] }), context()))).toEqual([
      'stock_below_safety',
    ]);
  });

  it('counts what this device has already promised offline', () => {
    const pending = [{ lines: [{ productId: 'p-coffee', quantity: 8 }] }];
    const decision = decideOfflineSale(
      basket({ lines: [{ productId: 'p-coffee', quantity: 3 }] }),
      context({ pending }),
    );

    expect(refusalCodes(decision)).toEqual(['stock_below_safety']);
    expect(tallyOfflineSales(pending).get('p-coffee')).toBe(8);
  });

  it('adds two lines of the same product together', () => {
    const decision = decideOfflineSale(
      basket({
        lines: [
          { productId: 'p-coffee', quantity: 6 },
          { productId: 'p-coffee', quantity: 5 },
        ],
      }),
      context(),
    );

    expect(refusalCodes(decision)).toEqual(['stock_below_safety']);
  });
});

describe('call numbers when the device has none for the day', () => {
  it('still sells, and says the bill will have no number', () => {
    const decision = decideOfflineSale(basket(), context({ callBlocks: [callBlock({ day: TOMORROW, from: 101, to: 200 })] }));

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.callNumber).toBeNull();
    expect(decision.warnings.map((warning) => warning.code)).toEqual(['no_call_number']);
    // Tomorrow's block is untouched: the sale is filed on a day it has no numbers for.
    expect(decision.callBlocks[0]?.lastUsed).toBeNull();
  });

  it('crosses midnight onto the block held for the new day', () => {
    const afterMidnight = new Date('2026-09-29T17:30:00.000Z'); // 00:30 on the 30th
    const decision = decideOfflineSale(
      basket(),
      context({ at: afterMidnight, callBlocks: [callBlock({ lastUsed: 99 }), callBlock({ day: TOMORROW, from: 101, to: 200 })] }),
    );

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.callNumber).toEqual({ value: 101, day: TOMORROW });
  });

  it('warns before the numbers run out, not after', () => {
    const decision = decideOfflineSale(
      basket(),
      context({
        callBlocks: [callBlock({ from: 1, to: 100, lastUsed: 90 })],
        receiptBlock: vatReceiptBlock({ lastUsed: 539 }),
      }),
    );

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.warnings.map((warning) => warning.code)).toEqual(['numbers_low', 'numbers_low']);
  });
});

describe('a basket that could not have come from the till', () => {
  it('is a programming mistake, so it throws rather than refusing politely', () => {
    expect(() => decideOfflineSale(basket({ lines: [] }), context())).toThrow(/at least one line/);
    expect(() =>
      decideOfflineSale(basket({ lines: [{ productId: 'p-coffee', quantity: 1.5 }] }), context()),
    ).toThrow(/positive whole number/);
  });
});
