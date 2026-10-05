// Seam under test: what a partial refund is worth.
//
// This is the arithmetic that makes a credit note a document rather than a
// number, and it is the reason partial refunds were deferred until now: a wrong
// figure here is a wrong figure on a tax document, and the failure is invisible —
// each note looks plausible on its own, and the shop only finds out that the notes
// do not add up to the invoice when somebody adds them up.
//
// So the property under test is not "this number is 97" but **the parts sum to the
// whole, to the satang, however the customer splits it**.
import { describe, expect, it } from 'vitest';

import { ValidationError } from '@/lib/errors';
import { sumThb } from '@/lib/money';
import { planRefund, refundTax, type RefundableLine } from '@/lib/refund-plan';

/** A three-line sale of ฿100 each, with a ฿10 order-level discount. */
const THREE: RefundableLine[] = [
  { orderItemId: 'a', name: 'กาแฟ', quantity: 1, returnedQuantity: 0, totalPrice: 100 },
  { orderItemId: 'b', name: 'น้ำเปล่า', quantity: 1, returnedQuantity: 0, totalPrice: 100 },
  { orderItemId: 'c', name: 'ขนมปัง', quantity: 1, returnedQuantity: 0, totalPrice: 100 },
];

const SALE = {
  subtotalThb: 300,
  discountThb: 10,
  finalAmountThb: 290,
};

describe('refunding everything that is left', () => {
  it('gives back exactly what was paid, discount included', () => {
    const plan = planRefund({
      lines: THREE,
      requested: null,
      ...SALE,
      alreadyRefundedThb: 0,
    });

    expect(plan.refundThb).toBe(290);
    expect(plan.grossThb).toBe(300);
    expect(plan.discountThb).toBe(10);
    expect(plan.returnedUnits).toBe(3);
    expect(plan.closes).toBe(true);
  });

  it('leaves the lines and the discount adding up to the total', () => {
    // The document prints three line totals and a discount; those four numbers
    // have to reach the refund on the note, or it is not a document.
    const plan = planRefund({
      lines: THREE,
      requested: null,
      ...SALE,
      alreadyRefundedThb: 0,
    });

    expect(plan.grossThb - plan.discountThb).toBe(plan.refundThb);
  });
});

describe('refunding one line of three', () => {
  it('gives back that line, less its share of the discount', () => {
    const plan = planRefund({
      lines: THREE,
      requested: [{ orderItemId: 'b', quantity: 1 }],
      ...SALE,
      alreadyRefundedThb: 0,
    });

    // ฿100 of ฿300, so a third of the ฿10 discount: ฿3.333, rounded to satang.
    expect(plan.discountThb).toBe(3.33);
    expect(plan.refundThb).toBe(96.67);
    expect(plan.closes).toBe(false);
    expect(plan.lines).toEqual([
      { orderItemId: 'b', name: 'น้ำเปล่า', quantity: 1, unitPrice: 100, lineTotal: 100 },
    ]);
  });

  it('and the rest closes the bill exactly', () => {
    /*
     * The property the whole design rests on. The first note rounds its discount
     * share — any pro-rata scheme has to — and the note that empties the order
     * takes the remainder instead of computing its own, so the customer is never
     * ฿0.01 short of whole with nothing left to refund.
     */
    const first = planRefund({
      lines: THREE,
      requested: [{ orderItemId: 'b', quantity: 1 }],
      ...SALE,
      alreadyRefundedThb: 0,
    });
    const second = planRefund({
      lines: THREE.map((line) => (line.orderItemId === 'b' ? { ...line, returnedQuantity: 1 } : line)),
      requested: null,
      ...SALE,
      alreadyRefundedThb: first.refundThb,
    });

    expect(second.closes).toBe(true);
    expect(first.refundThb + second.refundThb).toBe(SALE.finalAmountThb);
    expect(first.discountThb + second.discountThb).toBe(SALE.discountThb);
    expect(second.grossThb - second.discountThb).toBe(second.refundThb);
  });

  it('survives a split that cannot divide evenly, to the satang', () => {
    // ฿99.99 across three lines of ฿33.33 with a ฿5 discount: every share is a
    // repeating fraction, and the parts still have to reach the whole.
    const lines: RefundableLine[] = [
      { orderItemId: 'a', name: 'หนึ่ง', quantity: 1, returnedQuantity: 0, totalPrice: 33.33 },
      { orderItemId: 'b', name: 'สอง', quantity: 1, returnedQuantity: 0, totalPrice: 33.33 },
      { orderItemId: 'c', name: 'สาม', quantity: 1, returnedQuantity: 0, totalPrice: 33.33 },
    ];
    const sale = { subtotalThb: 99.99, discountThb: 5, finalAmountThb: 94.99 };

    const refunds: number[] = [];
    const discounts: number[] = [];

    for (const [index, line] of lines.entries()) {
      const plan = planRefund({
        lines: lines.map((candidate, position) =>
          position < index ? { ...candidate, returnedQuantity: 1 } : candidate,
        ),
        requested: [{ orderItemId: line.orderItemId, quantity: 1 }],
        ...sale,
        // Summed with the project's own satang helper, because adding the notes up
        // is exactly what a shop does and floats must not be how they find out.
        alreadyRefundedThb: sumThb(refunds),
      });
      refunds.push(plan.refundThb);
      discounts.push(plan.discountThb);
    }

    expect(sumThb(refunds)).toBe(sale.finalAmountThb);
    expect(sumThb(discounts)).toBe(sale.discountThb);
    // Every note on its own is a positive amount — a zero-value credit note is not
    // a document, and the database refuses one.
    expect(refunds.every((amount) => amount > 0)).toBe(true);
  });
});

describe('refunding part of one line', () => {
  const FIVE: RefundableLine[] = [
    { orderItemId: 'a', name: 'กาแฟ', quantity: 5, returnedQuantity: 0, totalPrice: 505 },
  ];

  it('gives back a share of the line, in whole units', () => {
    const plan = planRefund({
      lines: FIVE,
      requested: [{ orderItemId: 'a', quantity: 2 }],
      subtotalThb: 505,
      discountThb: 5,
      finalAmountThb: 500,
      alreadyRefundedThb: 0,
    });

    // 2 units of 101 each = 202 gross, less ฿5 × 202/505 = ฿2.
    expect(plan.grossThb).toBe(202);
    expect(plan.discountThb).toBe(2);
    expect(plan.refundThb).toBe(200);
    expect(plan.lines[0]?.unitPrice).toBe(101);
    expect(plan.lines[0]?.lineTotal).toBe(202);
    expect(plan.closes).toBe(false);
  });

  it('and the remaining three units close it', () => {
    const plan = planRefund({
      lines: [{ ...FIVE[0]!, returnedQuantity: 2 }],
      requested: null,
      subtotalThb: 505,
      discountThb: 5,
      finalAmountThb: 500,
      alreadyRefundedThb: 200,
    });

    expect(plan.returnedUnits).toBe(3);
    expect(plan.refundThb).toBe(300);
    expect(plan.grossThb - plan.discountThb).toBe(300);
    expect(plan.closes).toBe(true);
  });

  it('refuses to return more units than are left', () => {
    expect(() =>
      planRefund({
        lines: [{ ...FIVE[0]!, returnedQuantity: 4 }],
        requested: [{ orderItemId: 'a', quantity: 2 }],
        subtotalThb: 505,
        discountThb: 5,
        finalAmountThb: 500,
        alreadyRefundedThb: 0,
      }),
    ).toThrow(ValidationError);
  });
});

describe('a request that cannot be honoured', () => {
  const base = {
    lines: THREE,
    subtotalThb: 300,
    discountThb: 10,
    finalAmountThb: 290,
    alreadyRefundedThb: 0,
  };

  it('refuses an order item that is not on the sale', () => {
    expect(() =>
      planRefund({ ...base, requested: [{ orderItemId: 'nope', quantity: 1 }] }),
    ).toThrow(/ไม่พบในบิลนี้/);
  });

  it('refuses a fractional or non-positive quantity', () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(() =>
        planRefund({ ...base, requested: [{ orderItemId: 'a', quantity }] }),
      ).toThrow(ValidationError);
    }
  });

  it('refuses a line that has already gone back in full', () => {
    expect(() =>
      planRefund({
        ...base,
        lines: [{ ...THREE[0]!, returnedQuantity: 1 }, ...THREE.slice(1)],
        requested: [{ orderItemId: 'a', quantity: 1 }],
      }),
    ).toThrow(/ถูกคืนไปหมดแล้ว/);
  });

  it('refuses an empty request rather than issuing a zero-value note', () => {
    expect(() => planRefund({ ...base, requested: [] })).toThrow(ValidationError);
  });

  it('names every line it refuses in one pass, not one error per call', () => {
    // A till that has to be told twice about the same request is a till somebody
    // works around.
    const failure = (() => {
      try {
        planRefund({
          ...base,
          requested: [
            { orderItemId: 'nope', quantity: 1 },
            { orderItemId: 'a', quantity: 9 },
          ],
        });
        return null;
      } catch (error) {
        return error as ValidationError;
      }
    })();

    expect(failure?.message).toContain('ไม่พบในบิลนี้');
    expect(failure?.message).toContain('เหลือคืนได้อีก 1 ชิ้น');
  });
});

describe('the tax inside a refund', () => {
  it('derives the tax from the gross, the same way the sale did', () => {
    // ฿107 of a 7% VAT-inclusive shop is ฿100 net + ฿7 tax, which is the figure the
    // invoice printed and therefore the figure the credit note must mirror.
    expect(refundTax({ refundThb: 107, ratePercent: 7, isVatInvoice: true })).toEqual({
      netThb: 100,
      vatThb: 7,
    });
  });

  it('gives a shop that is not VAT-registered no tax line at all', () => {
    expect(refundTax({ refundThb: 107, ratePercent: 0, isVatInvoice: false })).toEqual({
      netThb: 107,
      vatThb: 0,
    });
  });

  it('reconstructs the sale’s own tax exactly when the note closes it', () => {
    /*
     * Three notes of ฿31.66 each: every one rounds its own tax, so their sum is not
     * the tax the invoice charged. The closing note is given the sale's net less
     * what the others claimed, which is what makes the notes reconstruct the
     * invoice to the satang — and what `chk_credit_notes_vat_reconstruction` and the
     * reports that subtract them both depend on.
     */
    const parts = [31.66, 31.66, 31.68];
    const nets: number[] = [];
    let claimedNet = 0;

    parts.forEach((part, index) => {
      const closing = index === parts.length - 1;
      const tax = refundTax({
        refundThb: part,
        ratePercent: 7,
        isVatInvoice: true,
        netOverride: closing ? 88.79 - claimedNet : null,
      });
      nets.push(tax.netThb);
      claimedNet += tax.netThb;
      // Every note still satisfies the database's own reconstruction check.
      expect(sumThb([tax.netThb, tax.vatThb])).toBe(part);
    });

    expect(sumThb(nets)).toBe(88.79);
  });
});

describe('the lines a refund names', () => {
  it('adds up two requests for the same line rather than refunding it twice', () => {
    const plan = planRefund({
      lines: [{ orderItemId: 'a', name: 'กาแฟ', quantity: 3, returnedQuantity: 0, totalPrice: 300 }],
      requested: [
        { orderItemId: 'a', quantity: 1 },
        { orderItemId: 'a', quantity: 2 },
      ],
      subtotalThb: 300,
      discountThb: 0,
      finalAmountThb: 300,
      alreadyRefundedThb: 0,
    });

    expect(plan.lines).toHaveLength(1);
    expect(plan.returnedUnits).toBe(3);
    expect(plan.refundThb).toBe(300);
  });

  it('keeps the sale’s line order, so the note reads like the invoice it reverses', () => {
    const plan = planRefund({
      lines: THREE,
      requested: [
        { orderItemId: 'c', quantity: 1 },
        { orderItemId: 'a', quantity: 1 },
      ],
      ...SALE,
      alreadyRefundedThb: 0,
    });

    expect(plan.lines.map((line) => line.orderItemId)).toEqual(['a', 'c']);
  });
});
