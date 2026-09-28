/**
 * Chart arithmetic — pure, and separate from the component that draws.
 *
 * The reason this is a module rather than a handful of expressions inside an SVG
 * component is the same one that makes `formatThb` hand-rolled: an axis is a
 * *decision* (what the top of the scale is, what a tick reads as, which day is
 * which), and a decision buried in JSX can only be checked by looking at it.
 *
 * It also removes a hydration hazard. The chart this replaces labelled its axis
 * with `toLocaleDateString('th-TH', …)`, which resolves against whatever ICU data
 * the rendering host carries — so the server and the browser can disagree about
 * which month abbreviation to use, and React reports a mismatch.
 */
import { formatThbShort } from './money';

export interface TrendPoint {
  /** Already-formatted axis label. */
  label: string;
  value: number;
  /** A second series drawn on its own scale — the same days, a different unit. */
  secondary?: number;
  /** Long description, used as the hover title. */
  caption?: string;
}

/**
 * The multipliers an axis step is allowed to take.
 *
 * 1/2/5/10 is the textbook set and it wastes a chart: a peak of 1,200 with a
 * division of 4 wants a step of 300, not 500, and the difference between 1,500 and
 * 2,000 of headroom is a tenth of the plot. 1.5, 2.5 and 7.5 fill those gaps.
 */
const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10] as const;

/** The smallest allowed multiplier that reaches `value`, at `value`'s own scale. */
function niceStep(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = STEPS.find((candidate) => scaled <= candidate + 1e-9) ?? 10;
  return step * magnitude;
}

/**
 * The top of an axis and the ticks that label it.
 *
 * Both come out of one step, which is what keeps the labels readable: rounding the
 * maximum and *then* dividing by four produces ticks at 375 and 750, and an axis
 * whose labels are arbitrary numbers is an axis nobody reads.
 *
 * A series with nothing in it — or with a negative peak, which a day of refunds
 * can produce — gets a flat axis at zero rather than a made-up scale, because a
 * chart of one flat line is the truthful picture.
 */
export function axisFor(value: number, divisions = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(value) || value <= 0) {
    return { max: 0, ticks: [0] };
  }
  const step = niceStep(value / divisions);
  const max = step * divisions;
  return { max, ticks: Array.from({ length: divisions + 1 }, (_, index) => index * step) };
}

/** The Thai abbreviations, in calendar order, exactly as they are written. */
const THAI_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
] as const;

/**
 * `2026-09-28` → `28 ก.ย.`
 *
 * Parsed by hand rather than through `Date`, so a day string means the same day
 * everywhere: `new Date('2026-09-28')` is UTC midnight, which in Bangkok is the
 * 28th and in Los Angeles the 27th, and an axis that shifts by a day depending on
 * who is looking at it is worse than no axis at all.
 *
 * Anything that is not an ISO day comes back unchanged — a label the caller
 * produced is the caller's business.
 */
export function shortThaiDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!match) {
    return day;
  }
  const monthIndex = Number(match[2]) - 1;
  const month = THAI_MONTHS[monthIndex];
  return month ? `${Number(match[3])} ${month}` : day;
}

/** The axis-label form of a money value: `฿1,234`, with no satang. */
export function axisLabelThb(value: number): string {
  return formatThbShort(value);
}

/** The largest value in a series, or 0 when there is nothing to plot. */
export function peak(values: number[]): number {
  return values.reduce((highest, value) => (Number.isFinite(value) && value > highest ? value : highest), 0);
}
