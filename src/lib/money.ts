/**
 * Money helpers.
 *
 * THB amounts are carried as JS numbers but every arithmetic step goes through
 * integer satang, so the classic `0.1 + 0.2` residue can never surface as a
 * phantom one-satang cash-drawer discrepancy.
 */

/** Currency amounts are rounded to this many decimal places (satang). */
const SATANG_PER_THB = 100;

/**
 * Converts a Prisma `Decimal` (or a plain number) to a THB number.
 *
 * Prisma hands back NUMERIC(10,2) columns as decimal.js instances, which are
 * not numbers and do not survive `JSON.stringify` in the shape we want.
 */
export function fromDecimal(value: { toNumber?: () => number; toString(): string } | number): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  return Number(value.toString());
}

/** Rounds a THB amount to the nearest satang. */
export function roundThb(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return Math.round(amount * SATANG_PER_THB) / SATANG_PER_THB;
}

/** Converts THB to integer satang. */
export function toSatang(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return Math.round(amount * SATANG_PER_THB);
}

/** Converts integer satang back to a THB number. */
export function fromSatang(satang: number): number {
  return satang / SATANG_PER_THB;
}

/** Sums THB amounts exactly. */
export function sumThb(amounts: number[]): number {
  return fromSatang(amounts.reduce((total, amount) => total + toSatang(amount), 0));
}

/** Subtracts THB amounts exactly. */
export function subtractThb(left: number, right: number): number {
  return fromSatang(toSatang(left) - toSatang(right));
}

/**
 * Renders a THB amount as `฿1,234.50`.
 *
 * Hand-rolled rather than delegated to `Intl.NumberFormat`, because Thai locale
 * currency output differs between ICU builds (`THB 1,234.50`, `฿1,234.50`) and
 * receipts must not change shape depending on the host's ICU version.
 */
export function formatThb(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const negative = safe < 0;
  const satang = Math.round(Math.abs(safe) * SATANG_PER_THB);
  const whole = Math.floor(satang / SATANG_PER_THB);
  const fraction = satang % SATANG_PER_THB;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}฿${grouped}.${fraction.toString().padStart(2, '0')}`;
}

/**
 * `฿1,234` — the whole-baht form, for the one place satang are noise.
 *
 * Axis labels: a scale of `฿1,000.00 / ฿2,000.00 / ฿3,000.00` is three quarters
 * punctuation, and the reader needs the shape of the trend rather than the exact
 * figure — which is what the point's own tooltip is for.
 */
export function formatThbShort(amount: number): string {
  return formatThb(amount).replace(/\.00$/, '');
}
