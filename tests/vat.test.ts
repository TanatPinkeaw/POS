// Seam under test: the VAT breakdown.
//
// Pure arithmetic, so it is tested without a database — but the property that
// matters is not "is the formula right", it is "do the printed lines sum back to
// the printed total, for every amount". A tax receipt whose lines do not add up
// is a document that does not balance, which is why the reconstruction is
// asserted over a large random sample rather than a few chosen examples.
import { describe, expect, it } from 'vitest';

import { toSatang } from '@/lib/money';
import { computeVat, formatTaxRate, vatFromExclusive, vatFromInclusive } from '@/lib/vat';

describe('deriving VAT from an inclusive price', () => {
  it('splits 107.00 at 7% into 100.00 plus 7.00', () => {
    const parts = vatFromInclusive(107, 7);
    expect(parts.netThb).toBe(100);
    expect(parts.vatThb).toBe(7);
    expect(parts.grossThb).toBe(107);
  });

  it('reconstructs the gross exactly across 20,000 random amounts', () => {
    let mismatches = 0;
    let firstMismatch: string | null = null;

    for (let index = 0; index < 20_000; index += 1) {
      // Any amount a till could ring up, to the satang.
      const gross = Math.round(Math.random() * 1_000_000) / 100;
      const parts = vatFromInclusive(gross, 7);
      const sum = toSatang(parts.netThb) + toSatang(parts.vatThb);
      if (sum !== toSatang(gross)) {
        mismatches += 1;
        firstMismatch ??= `${gross} → ${parts.netThb} + ${parts.vatThb}`;
      }
    }

    expect(firstMismatch).toBeNull();
    expect(mismatches).toBe(0);
  });

  it('holds on the smallest amounts, where rounding has nowhere to hide', () => {
    for (const gross of [0, 0.01, 0.02, 0.07, 0.5, 1, 1.07]) {
      const parts = vatFromInclusive(gross, 7);
      expect(toSatang(parts.netThb) + toSatang(parts.vatThb)).toBe(toSatang(gross));
    }
  });

  it('charges nothing at a zero rate', () => {
    const parts = vatFromInclusive(250, 0);
    expect(parts.vatThb).toBe(0);
    expect(parts.netThb).toBe(250);
  });
});

describe('adding VAT to an exclusive price', () => {
  it('turns 100.00 at 7% into 107.00', () => {
    const parts = vatFromExclusive(100, 7);
    expect(parts.vatThb).toBe(7);
    expect(parts.grossThb).toBe(107);
  });

  it('reconstructs the net exactly across 20,000 random amounts', () => {
    let mismatches = 0;
    for (let index = 0; index < 20_000; index += 1) {
      const net = Math.round(Math.random() * 1_000_000) / 100;
      const parts = vatFromExclusive(net, 7);
      if (toSatang(parts.grossThb) - toSatang(parts.vatThb) !== toSatang(parts.netThb)) {
        mismatches += 1;
      }
    }
    expect(mismatches).toBe(0);
  });
});

describe('computeVat', () => {
  it('records no tax at all for a shop that is not VAT-registered', () => {
    const breakdown = computeVat({
      amountThb: 107,
      ratePercent: 7,
      pricesIncludeVat: true,
      isVatRegistered: false,
    });

    expect(breakdown.vatThb).toBe(0);
    expect(breakdown.netThb).toBe(107);
    expect(breakdown.grossThb).toBe(107);
    expect(breakdown.ratePercent).toBe(0);
    expect(breakdown.isVatInvoice).toBe(false);
  });

  it('leaves the amount the customer pays untouched in inclusive mode', () => {
    // The whole reason introducing VAT did not change a single existing figure:
    // 250.00 in, 250.00 out, with the tax taken out of it.
    const breakdown = computeVat({
      amountThb: 250,
      ratePercent: 7,
      pricesIncludeVat: true,
      isVatRegistered: true,
    });

    expect(breakdown.grossThb).toBe(250);
    expect(breakdown.netThb + breakdown.vatThb).toBe(250);
    expect(breakdown.isVatInvoice).toBe(true);
    expect(breakdown.ratePercent).toBe(7);
  });

  it('raises the amount due in exclusive mode', () => {
    const breakdown = computeVat({
      amountThb: 250,
      ratePercent: 7,
      pricesIncludeVat: false,
      isVatRegistered: true,
    });

    expect(breakdown.netThb).toBe(250);
    expect(breakdown.grossThb).toBe(267.5);
  });

  it('impossible rates are treated as no tax rather than producing nonsense', () => {
    for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, -7]) {
      const breakdown = computeVat({
        amountThb: 100,
        ratePercent: rate,
        pricesIncludeVat: true,
        isVatRegistered: true,
      });
      expect(breakdown.vatThb).toBe(0);
      expect(breakdown.ratePercent).toBe(0);
    }
  });
});

describe('formatTaxRate', () => {
  it('renders a whole rate without decimals and a fractional one without padding', () => {
    expect(formatTaxRate(7)).toBe('7%');
    expect(formatTaxRate(7.5)).toBe('7.5%');
    expect(formatTaxRate(0)).toBe('0%');
  });
});
