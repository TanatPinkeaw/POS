// Seam under test: the day's confirmed transfers against the bills they closed.
//
// Pure arithmetic, tested because the verdict is read by somebody deciding
// whether to go looking for missing money. Two properties matter: a satang is a
// difference (this is a money figure, not a percentage), and the sign always says
// which side is larger rather than merely that they differ.
import { describe, expect, it } from 'vitest';

import { reconcileTransfers } from '@/lib/inbound-reconcile';

describe('transfers against the bills they closed', () => {
  it('says so when the same money is seen twice', () => {
    expect(reconcileTransfers({ confirmedThb: 1234.5, closedThb: 1234.5 })).toEqual({
      confirmedThb: 1234.5,
      closedThb: 1234.5,
      differenceThb: 0,
      verdict: 'balanced',
    });
  });

  it('treats a satang as a difference', () => {
    // The one thing this must not do is round a discrepancy away: ฿1,234.50 that
    // arrived and ฿1,234.49 that was billed is a bill that does not balance.
    const result = reconcileTransfers({ confirmedThb: 1234.5, closedThb: 1234.49 });
    expect(result.verdict).toBe('confirmed_more');
    expect(result.differenceThb).toBe(0.01);
  });

  it('names the side that is larger, in the direction money actually moved', () => {
    const tooMuch = reconcileTransfers({ confirmedThb: 500, closedThb: 300 });
    expect(tooMuch.verdict).toBe('confirmed_more');
    expect(tooMuch.differenceThb).toBe(200);

    const tooLittle = reconcileTransfers({ confirmedThb: 300, closedThb: 500 });
    expect(tooLittle.verdict).toBe('closed_more');
    // Signed, not absolute: -200 says which way round the two figures are, and a
    // screen rendering "200" beside the wrong sentence would be worse than useless.
    expect(tooLittle.differenceThb).toBe(-200);
  });

  it('is not fooled by float noise', () => {
    // 0.1 + 0.2 in binary floating point is not 0.3. Money here is compared in
    // satang for exactly this reason.
    const result = reconcileTransfers({ confirmedThb: 0.1 + 0.2, closedThb: 0.3 });
    expect(result.verdict).toBe('balanced');
    expect(result.differenceThb).toBe(0);
  });

  it('is balanced on a day with no transfers at all', () => {
    expect(reconcileTransfers({ confirmedThb: 0, closedThb: 0 })).toEqual({
      confirmedThb: 0,
      closedThb: 0,
      differenceThb: 0,
      verdict: 'balanced',
    });
  });

  it('rounds both sides to satang before deciding', () => {
    const result = reconcileTransfers({ confirmedThb: 107.006, closedThb: 107.0 });
    expect(result.confirmedThb).toBe(107.01);
    expect(result.verdict).toBe('confirmed_more');
  });
});
