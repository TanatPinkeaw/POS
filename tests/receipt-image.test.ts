// Seam under test: the receipt as an image (ADR 0021).
//
// `receipt-image.ts` builds the document's rows; `receipt-canvas.ts` puts them on a
// canvas. This suite pins the *content* — that every figure is read from the order
// rather than recomputed, that a VAT bill and a non-VAT bill differ in exactly the
// ways the law requires, and that the same order renders the same document twice.
//
// The drawing itself is exercised in real Chromium by `offline:browser`, because a
// canvas API mocked in Node proves nothing about pixels.
import { describe, expect, it } from 'vitest';

import type { ReceiptData } from '@/components/pos/Receipt';
import { DEFAULT_RECEIPT_CANVAS, receiptCanvasHeight, type ReceiptCanvasLine } from '@/lib/receipt-canvas';
import { buildReceiptLines } from '@/lib/receipt-image';
import type { ShopView } from '@/lib/shop-view';

/** A complete shop, so the fields this module reads are explicit rather than defaulted. */
function shop(overrides: Partial<ShopView> = {}): ShopView {
  return {
    name: 'ร้านกาแฟทดสอบ',
    legalName: null,
    branchLabel: 'สาขา 1',
    taxId: '1103700123456',
    address: null,
    phone: '021234567',
    isVatRegistered: true,
    callsNumbers: true,
    acceptsPreorders: true,
    vatRate: 7,
    pricesIncludeVat: true,
    receiptPrefix: 'RC',
    receiptRunningNumber: 123,
    receiptFooter: null,
    logoUrl: null,
    promptpayId: null,
    promptpayType: null,
    supervisorDiscountLimitThb: 50,
    ...overrides,
  };
}

/** An order whose lines add up: net 100 + VAT 7 = 107 due, paid with 110 cash. */
function vatOrder(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    orderNumber: 'OB-000123',
    receiptNumber: 'OB-2026-000123',
    queueNumber: '037',
    isVatInvoice: true,
    vatRatePercent: 7,
    netThb: 100,
    vatThb: 7,
    subtotalThb: 107,
    discountThb: 0,
    finalAmountThb: 107,
    tenders: [{ method: 'cash', amountThb: 107, receivedThb: 110 }],
    changeThb: 3,
    pointsEarned: 0,
    pointsRedeemed: 0,
    lines: [{ name: 'ชาเย็น', quantity: 1, unitPrice: 107, totalPrice: 107 }],
    createdAt: '2026-10-02T03:00:00.000Z',
    ...overrides,
  };
}

/** The label/value pairs, in the order they are drawn. */
function rows(lines: readonly ReceiptCanvasLine[]): [string, string][] {
  return lines
    .filter((line) => line.kind === 'row' || line.kind === 'smallRow' || line.kind === 'grandRow' || line.kind === 'totalRow')
    .map((line) => [line.label ?? '', line.value ?? '']);
}

const kinds = (lines: readonly ReceiptCanvasLine[]): string[] => lines.map((line) => line.kind);

describe('the receipt document as lines', () => {
  it('reads every figure from the order, so the same order prints the same bill', () => {
    const data = vatOrder();
    const lines = buildReceiptLines(shop(), data, '2026-10-02T03:00:00.000Z');

    expect(rows(lines)).toEqual([
      ['เลขที่', 'OB-2026-000123'],
      ['ออเดอร์', 'OB-000123'],
      ['วันที่', '02/10/2026 10:00'],
      ['ชาเย็น × 1', '107.00'],
      ['รวม', '107.00'],
      ['ยอดก่อน VAT', '100.00'],
      ['VAT 7%', '7.00'],
      ['ยอดชำระ', '107.00'],
      ['รับเงินสด', '110.00'],
      ['เงินทอน', '3.00'],
    ]);
  });

  it('is byte-for-byte the same document when built twice from one order', () => {
    const data = vatOrder();
    const first = buildReceiptLines(shop(), data, data.createdAt);
    const second = buildReceiptLines(shop(), data, data.createdAt);

    expect(second).toEqual(first);
  });

  it('names the call number above the document number, as the customer reads it', () => {
    const lines = buildReceiptLines(shop(), vatOrder(), '2026-10-02T03:00:00.000Z');
    const callIndex = kinds(lines).indexOf('call');

    expect(lines[callIndex]).toEqual({ kind: 'call', label: 'คิวที่', value: '037' });
    // The call number is the one non-record figure on the page, so it sits before
    // the เลขที่ row rather than beside it.
    expect(callIndex).toBeLessThan(kinds(lines).indexOf('row'));
  });

  it('shows the discount and the stored tax split on a VAT bill', () => {
    const data = vatOrder({ discountThb: 7, finalAmountThb: 100, changeThb: 0 });
    const lines = buildReceiptLines(shop(), data, '2026-10-02T03:00:00.000Z');

    expect(rows(lines)).toContainEqual(['ส่วนลด', '-7.00']);
    expect(kinds(lines)).toContain('smallRow');
  });

  it('prints the document name the law requires for a non-VAT shop', () => {
    const lines = buildReceiptLines(shop({ isVatRegistered: false }), nonVatOrder(), '2026-10-02T03:00:00.000Z');

    expect(lines.find((line) => line.kind === 'title')).toEqual({ kind: 'title', text: 'ใบเสร็จรับเงิน' });
    expect(kinds(lines)).not.toContain('smallRow');
    expect(rows(lines)).not.toContainEqual(['VAT 7%', '7.00']);
  });

  it('never prints a tax id or a tax split on a non-VAT bill', () => {
    const lines = buildReceiptLines(
      shop({ isVatRegistered: false, taxId: '1103700123456' }),
      nonVatOrder(),
      '2026-10-02T03:00:00.000Z',
    );
    const text = lines.map((line) => line.text ?? '').join('\n');

    expect(text).not.toContain('1103700123456');
    expect(text).not.toContain('VAT');
  });

  it('falls back to the order number when no invoice was issued', () => {
    const lines = buildReceiptLines(
      shop({ isVatRegistered: false }),
      nonVatOrder({ receiptNumber: null }),
      '2026-10-02T03:00:00.000Z',
    );

    expect(rows(lines)).toContainEqual(['เลขที่', 'OB-000200']);
    expect(rows(lines)).not.toContainEqual(['ออเดอร์', 'OB-000200']);
  });

  it('prints one leg per tender and the change, so the money adds up', () => {
    const lines = buildReceiptLines(
      shop({ isVatRegistered: false }),
      nonVatOrder({
        tenders: [
          { method: 'cash', amountThb: 52, receivedThb: 100 },
          { method: 'promptpay', amountThb: 50, receivedThb: null },
        ],
        changeThb: 48,
      }),
      '2026-10-02T03:00:00.000Z',
    );

    expect(rows(lines)).toContainEqual(['รับเงินสด', '100.00']);
    expect(rows(lines)).toContainEqual(['รับโอน (พร้อมเพย์)', '50.00']);
    expect(rows(lines)).toContainEqual(['เงินทอน', '48.00']);
  });

  it('prints the shop footer, or a thank-you when none is set', () => {
    const withFooter = buildReceiptLines(shop({ receiptFooter: '  มาอีกนะ  ' }), vatOrder());
    const without = buildReceiptLines(shop({ receiptFooter: null }), vatOrder());

    expect(withFooter.at(-1)).toEqual({ kind: 'foot', text: 'มาอีกนะ' });
    expect(without.at(-1)).toEqual({ kind: 'foot', text: 'ขอบคุณที่ใช้บริการ' });
  });

  it('prints the points the customer earned and spent', () => {
    const lines = buildReceiptLines(shop(), vatOrder({ pointsEarned: 12, pointsRedeemed: 50 }));

    expect(rows(lines)).toContainEqual(['ใช้คะแนน', '50']);
    expect(lines).toContainEqual({ kind: 'foot', text: 'ได้รับ 12 คะแนน' });
  });
});

/** A cash sale with no tax document, so the suite covers both shapes. */
function nonVatOrder(overrides: Partial<ReceiptData> = {}): ReceiptData {
  return {
    orderNumber: 'OB-000200',
    receiptNumber: null,
    queueNumber: null,
    isVatInvoice: false,
    vatRatePercent: null,
    netThb: 100,
    vatThb: 0,
    subtotalThb: 100,
    discountThb: 0,
    finalAmountThb: 100,
    tenders: [{ method: 'cash', amountThb: 100, receivedThb: 100 }],
    changeThb: 0,
    pointsEarned: 0,
    pointsRedeemed: 0,
    lines: [{ name: 'ลาเต้', quantity: 1, unitPrice: 100, totalPrice: 100 }],
    createdAt: '2026-10-02T03:00:00.000Z',
    ...overrides,
  };
}

describe('the height a canvas must be', () => {
  it('is twice the padding with nothing to draw', () => {
    expect(receiptCanvasHeight([], DEFAULT_RECEIPT_CANVAS)).toBe(DEFAULT_RECEIPT_CANVAS.padding * 2);
  });

  it('grows by a line height for a row and a rule height for a rule', () => {
    const { padding, lineHeight, ruleHeight } = DEFAULT_RECEIPT_CANVAS;

    expect(receiptCanvasHeight([{ kind: 'row', label: 'รวม', value: '107.00' }], DEFAULT_RECEIPT_CANVAS)).toBe(
      padding * 2 + lineHeight,
    );
    expect(receiptCanvasHeight([{ kind: 'rule' }], DEFAULT_RECEIPT_CANVAS)).toBe(padding * 2 + ruleHeight);
  });

  it('leaves room for the call number, which is drawn larger than a row', () => {
    const { padding, lineHeight } = DEFAULT_RECEIPT_CANVAS;

    expect(receiptCanvasHeight([{ kind: 'call', label: 'คิวที่', value: '037' }], DEFAULT_RECEIPT_CANVAS)).toBe(
      Math.ceil(padding * 2 + lineHeight * 1.8),
    );
  });

  it('sizes a 58mm roll, which is what a till prints', () => {
    expect(DEFAULT_RECEIPT_CANVAS.width).toBe(384);
  });
});
