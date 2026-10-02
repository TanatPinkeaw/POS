// Seam under test: which instant and which day a sale is filed under (ADR 0019).
//
// Pure, and worth its own suite because both answers are wrong in a way nobody sees
// immediately: a bill filed under the morning it synced moves money between days, and a
// bill filed under the server's local date moves it between timezones.
import { describe, expect, it } from 'vitest';

import { saleDay, saleInstant, SALE_INSTANT_COLUMN } from '@/lib/sale-instant';

/** 2026-09-30 08:12 Bangkok — the morning after the sale below. */
const MORNING = new Date('2026-09-30T01:12:00.000Z');
/** 2026-09-29 21:00 Bangkok. */
const LAST_NIGHT = new Date('2026-09-29T14:00:00.000Z');

describe('the instant a sale is filed under', () => {
  it('names the column the day comes from', () => {
    // The constant exists so the raw query in `analytics.ts` and every Prisma filter
    // cannot disagree about which column "the day of a sale" means.
    expect(SALE_INSTANT_COLUMN).toBe('sold_at');
  });

  it('uses the server clock for an ordinary sale', () => {
    const filed = saleInstant({ now: MORNING });

    expect(filed.at).toEqual(MORNING);
    expect(filed.clamped).toBe(false);
  });

  it('files a replayed bill under the instant the device sold it', () => {
    // The whole of decision 4: yesterday's takings, not this morning's.
    const filed = saleInstant({ now: MORNING, deviceInstant: LAST_NIGHT });

    expect(filed.at).toEqual(LAST_NIGHT);
    expect(filed.clamped).toBe(false);
    expect(saleDay(filed.at)).toBe('2026-09-29');
    expect(saleDay(MORNING)).toBe('2026-09-30');
  });

  it('refuses to file a sale in the future, and says that it did', () => {
    // A device whose clock runs ahead must not put money into a day that has not
    // happened: tomorrow's takings are reconciled before tomorrow arrives.
    const ahead = new Date('2026-09-30T09:00:00.000Z');
    const filed = saleInstant({ now: MORNING, deviceInstant: ahead });

    expect(filed.at).toEqual(MORNING);
    expect(filed.clamped).toBe(true);
  });

  it('does not call an instant identical to now a future one', () => {
    const filed = saleInstant({ now: MORNING, deviceInstant: new Date(MORNING) });

    expect(filed.at).toEqual(MORNING);
    expect(filed.clamped).toBe(false);
  });
});

describe('the Bangkok day of a sale', () => {
  it('puts a late-evening Bangkok sale on the day the customer was standing there', () => {
    // 2026-09-29 23:30 UTC is 2026-09-30 06:30 in Bangkok, and 18:00 UTC on the 29th is
    // already the 30th there. A server in UTC would file both under the 29th.
    expect(saleDay(new Date('2026-09-29T18:00:00.000Z'))).toBe('2026-09-30');
    expect(saleDay(new Date('2026-09-29T16:59:59.999Z'))).toBe('2026-09-29');
  });
});
