/**
 * Cash-drawer (shift) settlement — SRS §6.2.
 *
 *   discrepancy = actual − (initial + total cash sales − cash payouts)
 *
 * Only physical cash counts. PromptPay and points settlements never land in the
 * drawer, so the caller must pass cash sales alone; a cash payout to a consignor
 * *did* leave the drawer, so it comes off what the count should hold (ADR 0023 §6).
 */
import { fromSatang, toSatang } from './money';

/** Difference under half a satang is treated as an exact count. */
const BALANCED_TOLERANCE_SATANG = 0.5;

export type DiscrepancyKind = 'balanced' | 'shortage' | 'overage';

/** Cash the drawer should contain at close. */
export function computeExpectedCash(input: {
  initialCash: number;
  cashSales: number;
  /**
   * Cash handed to a consignor out of this drawer (ADR 0023 §6). Money that left the
   * till, so it reduces what the count should hold. Omitted means zero.
   */
  cashPayouts?: number;
}): number {
  return fromSatang(
    toSatang(input.initialCash) + toSatang(input.cashSales) - toSatang(input.cashPayouts ?? 0),
  );
}

/** Signed difference between counted cash and expected cash. */
export function computeCashDiscrepancy(input: {
  initialCash: number;
  cashSales: number;
  cashPayouts?: number;
  actualCash: number;
}): number {
  const expected = toSatang(
    computeExpectedCash({
      initialCash: input.initialCash,
      cashSales: input.cashSales,
      cashPayouts: input.cashPayouts ?? 0,
    }),
  );
  return fromSatang(toSatang(input.actualCash) - expected);
}

/** Labels a discrepancy for the admin review list. */
export function classifyDiscrepancy(discrepancy: number): DiscrepancyKind {
  const satang = toSatang(discrepancy);
  if (Math.abs(satang) < BALANCED_TOLERANCE_SATANG) {
    return 'balanced';
  }
  return satang < 0 ? 'shortage' : 'overage';
}
