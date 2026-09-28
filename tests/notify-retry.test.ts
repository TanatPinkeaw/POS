// Seam under test: how long to wait before trying again, and when to stop.
//
// A delivery that keeps failing is either a shop with a wrong URL (which a person
// must be told about) or a gateway having a bad afternoon (which retrying fixes).
// The schedule decides which of those the shop experiences.
import { describe, expect, it } from 'vitest';

import {
  MAX_ATTEMPTS,
  isAbandoned,
  nextAttemptAt,
  retryDelaySeconds,
} from '@/lib/notify-retry';

const NOW = new Date('2026-09-28T12:00:00.000Z');

describe('a delivery that failed', () => {
  it('waits longer each time, rather than hammering a gateway', () => {
    const delays = [1, 2, 3, 4].map(retryDelaySeconds);

    expect(delays[0]).toBeLessThan(delays[1] as number);
    expect(delays[1]).toBeLessThan(delays[2] as number);
    // Non-decreasing from there: the ceiling is a ceiling, not a return to zero.
    expect(delays[3]).toBeGreaterThanOrEqual(delays[2] as number);
  });

  it('starts quickly, because the first failure is usually a blip', () => {
    expect(retryDelaySeconds(1)).toBeLessThanOrEqual(60);
  });

  it('stops growing, so one outage does not become an infinite wait', () => {
    expect(retryDelaySeconds(50)).toBe(retryDelaySeconds(MAX_ATTEMPTS));
  });

  it('schedules the next try from now, in real time', () => {
    const next = nextAttemptAt({ attempts: 2, now: NOW });

    // Attempts are 1-based here: this is the attempt that just failed.
    expect(next.getTime() - NOW.getTime()).toBe(retryDelaySeconds(2) * 1000);
  });

  it('gives up rather than retrying forever', () => {
    expect(isAbandoned(MAX_ATTEMPTS)).toBe(true);
    expect(isAbandoned(MAX_ATTEMPTS - 1)).toBe(false);
    // A worker that has run more times than the cap — a bug, or a reset counter —
    // must not become a loop that runs forever.
    expect(isAbandoned(MAX_ATTEMPTS + 10)).toBe(true);
  });

  it('never schedules a retry in the past', () => {
    expect(nextAttemptAt({ attempts: 1, now: NOW }).getTime()).toBeGreaterThan(NOW.getTime());
  });
});
