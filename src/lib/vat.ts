/**
 * VAT — the arithmetic behind a tax receipt (ADR 0002).
 *
 * Pure and dependency-free on purpose: the sale path, the receipt, the settings
 * screen and the tests all call these same functions, so the tax line a customer
 * reads cannot drift from the tax line that was stored on the order.
 *
 * Two pricing conventions are supported, because Thailand uses both:
 *
 *   * **inclusive** (the retail norm, and this system's default) — the shelf
 *     price already contains VAT, so the tax is *derived* out of the amount due.
 *     Note that this leaves the sale arithmetic untouched: the customer still
 *     pays `subtotal - discount`. Only the breakdown is new.
 *   * **exclusive** — the shelf price excludes VAT, which is added at the till.
 *
 * Every function works in integer satang (see `money.ts`). The critical property,
 * asserted by property-style tests over thousands of random amounts, is that
 * `netThb + vatThb === grossThb` *exactly* — a tax receipt whose lines do not add
 * up to the total is not a rounding nit, it is a document that does not balance.
 */
import { fromSatang, roundThb, toSatang } from './money';

export interface VatBreakdown {
  /** The taxable base. */
  netThb: number;
  /** The tax itself. */
  vatThb: number;
  /** What the customer actually pays. */
  grossThb: number;
  /** The rate applied, snapshotted onto the order. 0 when not VAT-registered. */
  ratePercent: number;
  /** Whether the rate was derived from, or added to, the price. */
  inclusive: boolean;
  /** Whether a tax invoice may be issued for this sale. */
  isVatInvoice: boolean;
}

/**
 * Derives the VAT contained in an inclusive (VAT-included) amount.
 *
 * `vat = gross × rate ÷ (100 + rate)`, rounded to satang, with the base taken as
 * the remainder. Computing the base by subtraction rather than by rounding it
 * independently is what makes the two lines sum back to the gross exactly.
 */
export function vatFromInclusive(
  grossThb: number,
  ratePercent: number,
): { netThb: number; vatThb: number; grossThb: number } {
  const grossSatang = toSatang(grossThb);
  const rate = normaliseRate(ratePercent);

  if (rate === 0) {
    return { netThb: fromSatang(grossSatang), vatThb: 0, grossThb: fromSatang(grossSatang) };
  }

  const vatSatang = Math.round((grossSatang * rate) / (100 + rate));
  return {
    netThb: fromSatang(grossSatang - vatSatang),
    vatThb: fromSatang(vatSatang),
    grossThb: fromSatang(grossSatang),
  };
}

/** Adds VAT to an exclusive (VAT-excluded) amount. */
export function vatFromExclusive(
  netThb: number,
  ratePercent: number,
): { netThb: number; vatThb: number; grossThb: number } {
  const netSatang = toSatang(netThb);
  const rate = normaliseRate(ratePercent);
  const vatSatang = Math.round((netSatang * rate) / 100);

  return {
    netThb: fromSatang(netSatang),
    vatThb: fromSatang(vatSatang),
    grossThb: fromSatang(netSatang + vatSatang),
  };
}

export interface VatInput {
  /**
   * The order total after any discount, *before* the tax decision: the price the
   * customer pays when prices include VAT, or the pre-tax base when they do not.
   */
  amountThb: number;
  ratePercent: number;
  pricesIncludeVat: boolean;
  isVatRegistered: boolean;
}

/**
 * Resolves the full breakdown for a sale under the shop's current settings.
 *
 * A shop that is not VAT-registered records no tax at all: its base is the whole
 * amount and the VAT line is zero. Recording a zero rather than leaving the
 * columns null means every order has one shape, and the receipt can decide what
 * to print from `isVatInvoice` alone.
 */
export function computeVat(input: VatInput): VatBreakdown {
  const amount = roundThb(input.amountThb);

  if (!input.isVatRegistered) {
    return {
      netThb: amount,
      vatThb: 0,
      grossThb: amount,
      ratePercent: 0,
      inclusive: input.pricesIncludeVat,
      isVatInvoice: false,
    };
  }

  const parts = input.pricesIncludeVat
    ? vatFromInclusive(amount, input.ratePercent)
    : vatFromExclusive(amount, input.ratePercent);

  return {
    netThb: parts.netThb,
    vatThb: parts.vatThb,
    grossThb: parts.grossThb,
    ratePercent: normaliseRate(input.ratePercent),
    inclusive: input.pricesIncludeVat,
    isVatInvoice: true,
  };
}

/** Formats a rate for display: `7` → `7%`, `7.5` → `7.5%`. */
export function formatTaxRate(ratePercent: number): string {
  const rate = normaliseRate(ratePercent);
  const text = Number.isInteger(rate) ? rate.toFixed(0) : rate.toFixed(2).replace(/0+$/, '');
  return `${text}%`;
}

/** A rate is a percentage between 0 and 100; anything else is treated as none. */
function normaliseRate(ratePercent: number): number {
  if (!Number.isFinite(ratePercent) || ratePercent <= 0) {
    return 0;
  }
  return Math.min(ratePercent, 100);
}
