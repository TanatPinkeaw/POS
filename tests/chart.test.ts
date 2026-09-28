import { describe, expect, it } from 'vitest';

import { axisFor, axisLabelThb, peak, shortThaiDay } from '@/lib/chart';

describe('axisFor', () => {
  it('fits an exact peak without wasting headroom', () => {
    // 12,000 over four divisions wants a step of 3,000. Rounding the maximum to a
    // "nice" 20,000 first — the obvious implementation — would leave a third of the
    // plot empty on the one chart a manager actually reads.
    const { max, ticks } = axisFor(12_000);
    expect(max).toBe(12_000);
    expect(ticks).toEqual([0, 3_000, 6_000, 9_000, 12_000]);
  });

  it('rounds up to a step a person would write down', () => {
    const { max, ticks } = axisFor(12_500);
    expect(max).toBe(16_000);
    expect(ticks).toEqual([0, 4_000, 8_000, 12_000, 16_000]);
  });

  it('never lets the peak run past the top of the axis', () => {
    // The one property that makes a chart wrong rather than ugly: a bar drawn past
    // the axis reads as a value that is not there.
    for (const value of [1, 7, 42, 99, 100, 101, 999, 1_001, 23_456, 999_999, 3.7]) {
      expect(axisFor(value).max, `peak ${value}`).toBeGreaterThanOrEqual(value);
    }
  });

  it('always produces one more tick than it has divisions', () => {
    for (const value of [1, 250, 3_333, 88_888]) {
      expect(axisFor(value, 4).ticks).toHaveLength(5);
      expect(axisFor(value, 2).ticks).toHaveLength(3);
    }
  });

  it('falls back to a flat axis when there is nothing to plot', () => {
    // A minute of takings on a slow morning is zero, and a day of refunds is
    // negative. Neither is a scale, so neither gets an invented one.
    expect(axisFor(0)).toEqual({ max: 0, ticks: [0] });
    expect(axisFor(-450)).toEqual({ max: 0, ticks: [0] });
    expect(axisFor(Number.NaN)).toEqual({ max: 0, ticks: [0] });
  });

  it('scales down to satang-sized values', () => {
    expect(axisFor(3.7).max).toBe(4);
  });
});

describe('peak', () => {
  it('ignores what is not a number', () => {
    expect(peak([3, Number.NaN, 9, 1])).toBe(9);
    expect(peak([])).toBe(0);
  });
});

describe('shortThaiDay', () => {
  it('writes a day the way a Thai date is written', () => {
    expect(shortThaiDay('2026-09-28')).toBe('28 ก.ย.');
    expect(shortThaiDay('2026-01-05')).toBe('5 ม.ค.');
    expect(shortThaiDay('2026-12-31')).toBe('31 ธ.ค.');
  });

  it('does not go through Date, so the day never shifts', () => {
    // `new Date('2026-09-01')` is UTC midnight: the 1st in Bangkok, but the 31st of
    // August in Los Angeles. An axis label that depends on who is reading it is
    // worse than no label, and the server and the browser would disagree anyway.
    expect(shortThaiDay('2026-09-01')).toBe('1 ก.ย.');
  });

  it('passes anything that is not an ISO day straight through', () => {
    expect(shortThaiDay('สัปดาห์นี้')).toBe('สัปดาห์นี้');
    expect(shortThaiDay('2026-13-01')).toBe('2026-13-01');
  });
});

describe('axisLabelThb', () => {
  it('drops the satang that would turn an axis into punctuation', () => {
    expect(axisLabelThb(0)).toBe('฿0');
    expect(axisLabelThb(1_234)).toBe('฿1,234');
    expect(axisLabelThb(1_234.5)).toBe('฿1,234.50');
  });
});
