import { describe, expect, it } from 'vitest';

import { DASHBOARD_DAYS, dashboardDays } from '@/lib/analytics';
import { addBangkokDays, bangkokDateString } from '@/lib/bangkok-time';

describe('dashboardDays', () => {
  it('covers a week ending today, oldest first', () => {
    const days = dashboardDays(new Date('2026-09-28T04:00:00Z'));
    expect(days).toHaveLength(DASHBOARD_DAYS);
    expect(days[0]).toBe('2026-09-22');
    expect(days[days.length - 1]).toBe('2026-09-28');
  });

  it('walks the calendar without gaps or repeats', () => {
    const days = dashboardDays(new Date('2026-03-02T04:00:00Z'));
    for (let index = 1; index < days.length; index += 1) {
      expect(days[index]).toBe(addBangkokDays(days[index - 1]!, 1));
    }
  });

  it('ends on the Bangkok day even when UTC is still yesterday', () => {
    // 18:30 UTC is 01:30 tomorrow in Bangkok — the boundary the old implementation
    // got wrong, because it started from the *host's* midnight and formatted
    // through `toISOString()`. Every key came out a day early, which put yesterday's
    // takings on today's bar and dropped the newest sales off the chart entirely.
    for (const hourUtc of [16, 17, 18, 23]) {
      const now = new Date(`2026-09-27T${hourUtc}:30:00Z`);
      const days = dashboardDays(now);
      expect(days[days.length - 1], `at ${hourUtc}:30Z`).toBe(bangkokDateString(now));
    }
  });

  it('does not depend on the host timezone', () => {
    // The same instant, described twice. A window built from local time is a
    // different window on two servers; this one is the shop's calendar.
    const instant = new Date('2026-12-31T20:00:00Z'); // 1 January in Bangkok
    expect(dashboardDays(instant)[DASHBOARD_DAYS - 1]).toBe('2027-01-01');
    expect(dashboardDays(instant)).toEqual([
      '2026-12-26',
      '2026-12-27',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
    ]);
  });
});
