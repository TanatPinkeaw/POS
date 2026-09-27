/**
 * Cash-drawer (shift) settlement — SRS §6.2.
 *
 *   discrepancy = actual − (initial + total cash sales)
 *
 * Only physical cash counts. PromptPay and points settlements never land in the
 * drawer, so the caller must pass cash sales alone.
 */
import { fromSatang, toSatang } from './money';

/** Difference under half a satang is treated as an exact count. */
const BALANCED_TOLERANCE_SATANG = 0.5;

export type DiscrepancyKind = 'balanced' | 'shortage' | 'overage';

/** Cash the drawer should contain at close. */
export function computeExpectedCash(input: {
  initialCash: number;
  cashSales: number;
}): number {
  return fromSatang(toSatang(input.initialCash) + toSatang(input.cashSales));
}

/** Signed difference between counted cash and expected cash. */
export function computeCashDiscrepancy(input: {
  initialCash: number;
  cashSales: number;
  actualCash: number;
}): number {
  const expected = toSatang(
    computeExpectedCash({ initialCash: input.initialCash, cashSales: input.cashSales }),
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
