// Seam under test: the arithmetic behind the storefront's basket — the numbers the
// basket card and the phone's follow-along bar both read.
//
// Pure, so it needs no browser and no database: what a customer selected is a
// function of the quantities and the catalogue. The bar's *layout* (that it sticks to
// the bottom, that tapping it lands on the basket without hiding the heading under
// the shell's top bar) is covered by the browser measurement in the plan, because
// that is a fact about pixels rather than about numbers.
import { describe, expect, it } from 'vitest';

import { basketSummary, type BasketProduct } from '@/lib/basket';

const product = (id: string, name: string, salePrice: number): BasketProduct => ({
  id,
  name,
  salePrice,
});

const COFFEE = product('p-coffee', 'กาแฟเย็น', 25);
const CAKE = product('p-cake', 'เค้กกล้วยหอม', 45);

describe('an empty basket', () => {
  it('is no lines, no pieces and no money', () => {
    expect(basketSummary({}, [COFFEE, CAKE])).toEqual({ lines: [], units: 0, totalThb: 0 });
  });
});

describe('what the customer selected', () => {
  it('counts pieces while the card lists lines, and both add to the same money', () => {
    const summary = basketSummary({ [COFFEE.id]: 2, [CAKE.id]: 1 }, [COFFEE, CAKE]);

    expect(summary.lines.map((line) => [line.name, line.quantity])).toEqual([
      ['กาแฟเย็น', 2],
      ['เค้กกล้วยหอม', 1],
    ]);
    // Two of one drink is three things to pick up, not two.
    expect(summary.units).toBe(3);
    expect(summary.totalThb).toBe(95);
    expect(summary.lines.map((line) => line.amountThb)).toEqual([50, 45]);
  });

  it('lists the lines in the order the customer picked them', () => {
    const summary = basketSummary({ [CAKE.id]: 1, [COFFEE.id]: 1 }, [COFFEE, CAKE]);

    expect(summary.lines.map((line) => line.productId)).toEqual([CAKE.id, COFFEE.id]);
  });

  it('keeps a free item, because a line at ฿0.00 is still something to hand over', () => {
    const summary = basketSummary({ 'p-free': 1 }, [product('p-free', 'ของแถม', 0)]);

    expect(summary.units).toBe(1);
    expect(summary.totalThb).toBe(0);
  });
});

describe('a quantity the steppers cannot produce', () => {
  it('is not a basket line', () => {
    const summary = basketSummary(
      { [COFFEE.id]: 0, 'p-cake': -2, 'p-other': 1.5 },
      [COFFEE, CAKE, product('p-other', 'ขนม', 10)],
    );

    expect(summary).toEqual({ lines: [], units: 0, totalThb: 0 });
  });
});

describe('a product that is no longer in the catalogue', () => {
  it('leaves the count as well as the total', () => {
    /*
     * The bug this pins: the inline arithmetic the screen used to hold counted a
     * stale id among its selected lines while adding nothing to the sum, so the
     * basket could show a phantom line at ฿0.00 and keep the reserve button enabled
     * for it. The catalogue is re-read from the server after a reservation, so a
     * product deactivated between the two reads arrives here as exactly this.
     */
    const summary = basketSummary({ gone: 3, [COFFEE.id]: 1 }, [COFFEE]);

    expect(summary.lines.map((line) => line.productId)).toEqual([COFFEE.id]);
    expect(summary.units).toBe(1);
    expect(summary.totalThb).toBe(25);
  });
});

describe('the total', () => {
  it('is summed in satang, so no float residue can reach the screen', () => {
    const summary = basketSummary({ a: 1, b: 1 }, [product('a', 'หนึ่งสตางค์', 0.1), product('b', 'สองสตางค์', 0.2)]);

    expect(summary.totalThb).toBe(0.3);
  });

  it('rounds each line to the nearest satang before adding it up', () => {
    // 17.555 × 3 is 52.665 in binary floating point; a receipt shows ฿52.67.
    const summary = basketSummary({ x: 3 }, [product('x', 'ชั่งน้ำหนัก', 17.555)]);

    expect(summary.lines[0]?.amountThb).toBe(52.67);
    expect(summary.totalThb).toBe(52.67);
  });
});
