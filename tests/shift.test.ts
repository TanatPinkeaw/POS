// Seam under test: cash-drawer settlement from SRS §6.2.
// The spec's formula is  discrepancy = actual − (initial + total cash sales).
import { describe, expect, it } from 'vitest';

import { classifyDiscrepancy, computeCashDiscrepancy, computeExpectedCash } from '@/lib/shifts';
import { formatThb, sumThb } from '@/lib/money';

describe('computeExpectedCash', () => {
  it('adds cash sales to the opening float', () => {
    // SRS §6.2: initial float 2,000 THB plus 4,500 THB of cash sales.
    expect(computeExpectedCash({ initialCash: 2000, cashSales: 4500 })).toBe(6500);
  });

  it('is just the float before anything is sold', () => {
    expect(computeExpectedCash({ initialCash: 2000, cashSales: 0 })).toBe(2000);
  });
});

describe('computeCashDiscrepancy', () => {
  it('is negative when the drawer is short', () => {
    const discrepancy = computeCashDiscrepancy({
      initialCash: 2000,
      cashSales: 4500,
      actualCash: 6450,
    });
    expect(discrepancy).toBe(-50);
  });

  it('is positive when the drawer has extra', () => {
    expect(
      computeCashDiscrepancy({ initialCash: 2000, cashSales: 4500, actualCash: 6512 }),
    ).toBe(12);
  });

  it('is zero on an exact count', () => {
    expect(
      computeCashDiscrepancy({ initialCash: 2000, cashSales: 4500, actualCash: 6500 }),
    ).toBe(0);
  });

  it('settles to satang without floating-point residue', () => {
    // 0.1 + 0.2 problems must not show up as a 1-satang phantom shortage.
    expect(
      computeCashDiscrepancy({ initialCash: 0.1, cashSales: 0.2, actualCash: 0.3 }),
    ).toBe(0);
  });
});

describe('classifyDiscrepancy', () => {
  it('labels the direction for admin review', () => {
    expect(classifyDiscrepancy(0)).toBe('balanced');
    expect(classifyDiscrepancy(-0.01)).toBe('shortage');
    expect(classifyDiscrepancy(-50)).toBe('shortage');
    expect(classifyDiscrepancy(0.01)).toBe('overage');
    expect(classifyDiscrepancy(12)).toBe('overage');
  });
});

describe('formatThb', () => {
  it('renders THB with two decimals', () => {
    expect(formatThb(1234.5)).toBe('฿1,234.50');
    expect(formatThb(0)).toBe('฿0.00');
    expect(formatThb(-50)).toBe('-฿50.00');
  });
});

describe('sumThb', () => {
  it('adds a list of satang amounts exactly', () => {
    expect(sumThb([0.1, 0.2])).toBe(0.3);
    expect(sumThb([19.99, 0.01])).toBe(20);
    expect(sumThb([])).toBe(0);
  });
});
