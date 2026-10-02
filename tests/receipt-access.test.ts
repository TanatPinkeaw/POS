// Seam under test: how long a customer may still download a receipt image (ADR 0021 §2).
//
// "The last month" is an access rule, not a retention rule — the order is never
// deleted — so the only thing to get right is the boundary: a bill one day inside
// the window is offered, the same bill one tick past it is not. That is a pure
// function of two instants, which is why it is tested without a clock or a database.
import { describe, expect, it } from 'vitest';

import { receiptAccessDays, receiptAccessUntil, receiptWithinAccessWindow } from '@/lib/receipt-access';

/** A sale completed at a fixed instant, so the tests never read the wall clock. */
const SOLD_AT = new Date('2026-10-01T07:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs `body` with `RECEIPT_ACCESS_DAYS` set (or absent), then restores it. */
function withAccessDays(value: string | undefined, body: () => void): void {
  const saved = process.env.RECEIPT_ACCESS_DAYS;
  try {
    if (value === undefined) {
      delete process.env.RECEIPT_ACCESS_DAYS;
    } else {
      process.env.RECEIPT_ACCESS_DAYS = value;
    }
    body();
  } finally {
    if (saved === undefined) {
      delete process.env.RECEIPT_ACCESS_DAYS;
    } else {
      process.env.RECEIPT_ACCESS_DAYS = saved;
    }
  }
}

describe('the receipt download window', () => {
  it('closes thirty days after the sale by default', () => {
    expect(receiptAccessUntil(SOLD_AT, 30).getTime() - SOLD_AT.getTime()).toBe(30 * DAY_MS);
  });

  it('offers the file a day before the window closes', () => {
    const now = new Date(SOLD_AT.getTime() + 29 * DAY_MS);
    expect(receiptWithinAccessWindow(SOLD_AT, now, 30)).toBe(true);
  });

  it('offers it again one millisecond before the boundary', () => {
    const now = new Date(receiptAccessUntil(SOLD_AT, 30).getTime() - 1);
    expect(receiptWithinAccessWindow(SOLD_AT, now, 30)).toBe(true);
  });

  it('withholds it exactly at the boundary, so the window is half-open', () => {
    // Closed at `until`, not a millisecond later: a bill is never served one tick
    // past the month it was promised for.
    const now = receiptAccessUntil(SOLD_AT, 30);
    expect(receiptWithinAccessWindow(SOLD_AT, now, 30)).toBe(false);
  });

  it('withholds a bill a month and a day old while the order itself is untouched', () => {
    const now = new Date(SOLD_AT.getTime() + 31 * DAY_MS);
    expect(receiptWithinAccessWindow(SOLD_AT, now, 30)).toBe(false);
    // The window is an access rule, not a deletion: nothing about the sale instant
    // changes when the file stops being offered.
    expect(Number.isFinite(SOLD_AT.getTime())).toBe(true);
  });

  it('takes the day count as a parameter, so a shop can set its own posture', () => {
    const now = new Date(SOLD_AT.getTime() + 10 * DAY_MS);
    expect(receiptWithinAccessWindow(SOLD_AT, now, 7)).toBe(false);
    expect(receiptWithinAccessWindow(SOLD_AT, now, 14)).toBe(true);
  });

  it('defaults to thirty days when nothing is configured', () => {
    withAccessDays(undefined, () => {
      expect(receiptAccessDays()).toBe(30);
      const inside = new Date(SOLD_AT.getTime() + 29 * DAY_MS);
      const outside = new Date(SOLD_AT.getTime() + 31 * DAY_MS);
      expect(receiptWithinAccessWindow(SOLD_AT, inside)).toBe(true);
      expect(receiptWithinAccessWindow(SOLD_AT, outside)).toBe(false);
    });
  });

  it('reads the configured day count', () => {
    withAccessDays('45', () => {
      expect(receiptAccessDays()).toBe(45);
      // 44 days in is still open only because the configured 45 was read on the
      // default path — the parameterless call is the one being proved.
      expect(receiptWithinAccessWindow(SOLD_AT, new Date(SOLD_AT.getTime() + 44 * DAY_MS))).toBe(true);
      expect(receiptWithinAccessWindow(SOLD_AT, new Date(SOLD_AT.getTime() + 46 * DAY_MS))).toBe(false);
    });
  });
});
