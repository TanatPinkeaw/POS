// Seam under test: a range of numbers lent to a device (ADR 0019).
//
// Pure on purpose. The rules that decide whether a shop's receipt series stays
// gapless have to be checkable without a database and without a browser, which is the
// same reason `refund-plan.ts` is pure — the alternative is discovering a hole in a
// document series at an audit.
//
// Not here: what a number *looks like* (`queue-number.ts`), and the half of the
// protocol that lives in Postgres (the freeze, `number-blocks.ts`), which lands with
// the reservation table.
import { describe, expect, it } from 'vitest';

import {
  blockForDay,
  blockSize,
  canReport,
  claim,
  isWellFormedBlock,
  nextValue,
  openBlockFor,
  remaining,
  replaceBlock,
  resumeAt,
  spend,
  spentCount,
  suggestBlockSize,
  type NumberBlock,
} from '@/lib/number-block';

function queueBlock(overrides: Partial<NumberBlock> = {}): NumberBlock {
  return { kind: 'queue', day: '2026-09-29', from: 1, to: 100, lastUsed: null, ...overrides };
}

function receiptBlock(overrides: Partial<NumberBlock> = {}): NumberBlock {
  return { kind: 'receipt', day: null, from: 500, to: 549, lastUsed: null, ...overrides };
}

describe('what a block holds', () => {
  it('starts at the first number and ends at the last', () => {
    const block = queueBlock({ from: 11, to: 20 });

    expect(nextValue(block)).toBe(11);
    expect(remaining(block)).toBe(10);
    expect(spentCount(block)).toBe(0);
    expect(blockSize(block)).toBe(10);
  });

  it('hands out the next number, and then the one after it', () => {
    const block = queueBlock({ lastUsed: 3 });

    expect(nextValue(block)).toBe(4);
    expect(remaining(block)).toBe(97);
    expect(spentCount(block)).toBe(3);
  });

  it('is spent once the last number has gone out', () => {
    const block = queueBlock({ from: 1, to: 3, lastUsed: 3 });

    expect(nextValue(block)).toBeNull();
    expect(remaining(block)).toBe(0);
    expect(spentCount(block)).toBe(3);
  });

  it('refuses to be read at all when its range runs backwards', () => {
    expect(isWellFormedBlock(queueBlock({ from: 50, to: 10 }))).toBe(false);
    expect(isWellFormedBlock(queueBlock({ from: 0, to: 10 }))).toBe(false);
    expect(isWellFormedBlock(queueBlock({ lastUsed: 101 }))).toBe(false);
    expect(isWellFormedBlock(queueBlock({ lastUsed: 0 }))).toBe(false);
    expect(isWellFormedBlock(queueBlock({ lastUsed: 100 }))).toBe(true);
  });
});

describe('spending one', () => {
  it('returns the number and the block as it now stands', () => {
    const taken = spend(queueBlock({ lastUsed: 9 }));

    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.value).toBe(10);
    expect(taken.block.lastUsed).toBe(10);
  });

  it('leaves the block it was given alone', () => {
    const block = queueBlock();
    spend(block);

    expect(block.lastUsed).toBeNull();
  });

  it('says it is exhausted rather than handing out a number past the end', () => {
    const taken = spend(queueBlock({ from: 1, to: 2, lastUsed: 2 }));

    expect(taken).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('refuses a malformed block instead of inventing a number from it', () => {
    expect(spend(queueBlock({ from: 50, to: 10 }))).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('giving the numbers back', () => {
  it('resumes the shop at the last number actually printed', () => {
    expect(resumeAt(queueBlock({ from: 500, to: 549, lastUsed: 517 }))).toBe(517);
  });

  it('gives a whole untouched block back to the shop', () => {
    expect(resumeAt(queueBlock({ from: 1, to: 100 }))).toBe(0);
    expect(resumeAt(receiptBlock())).toBe(499);
  });

  it('lets the lowest block of a range report first and refuses a later one', () => {
    const leftover = queueBlock({ day: '2026-09-29', from: 1, to: 100, lastUsed: 40 });
    const fresh = queueBlock({ day: '2026-09-29', from: 101, to: 200, lastUsed: 5 });
    const open = [leftover, fresh];

    expect(canReport(leftover, open)).toBe(true);
    // The fresh block's report would set the counter past numbers the leftover one may
    // still be spending: a hole, which is the one thing the protocol exists to prevent.
    expect(canReport(fresh, open)).toBe(false);
  });

  it('reports each day’s call numbers on its own, because the days are separate series', () => {
    const today = queueBlock({ day: '2026-09-29', from: 1, to: 100, lastUsed: 40 });
    const tomorrow = queueBlock({ day: '2026-09-30', from: 1, to: 100, lastUsed: 5 });

    // Both start at 1, so "the lowest" is meaningless across days — and a day's report
    // must not be blocked by another day's untouched block.
    expect(canReport(today, [today, tomorrow])).toBe(true);
    expect(canReport(tomorrow, [today, tomorrow])).toBe(true);
  });

  it('finds the open block of a series and ignores the other series', () => {
    const leftover = queueBlock({ from: 1, to: 100 });
    const fresh = queueBlock({ from: 101, to: 200 });
    const open = [fresh, leftover, receiptBlock({ from: 10, to: 20 })];

    expect(openBlockFor(open, 'queue', '2026-09-29')?.from).toBe(1);
    expect(openBlockFor(open, 'receipt', null)?.from).toBe(10);
    expect(openBlockFor([receiptBlock()], 'queue', '2026-09-29')).toBeNull();
    expect(openBlockFor([queueBlock()], 'receipt', null)).toBeNull();
  });
});

describe('which day a call-number block is for', () => {
  it('picks the block for that day and not the one beside it', () => {
    const today = queueBlock({ day: '2026-09-29', from: 1, to: 100 });
    const tomorrow = queueBlock({ day: '2026-09-30', from: 101, to: 200 });

    expect(blockForDay([today, tomorrow], '2026-09-29')?.from).toBe(1);
    expect(blockForDay([today, tomorrow], '2026-09-30')?.from).toBe(101);
    expect(blockForDay([today, tomorrow], '2026-10-01')).toBeNull();
  });

  it('spends a leftover block of the same day before the fresh one', () => {
    const leftover = queueBlock({ day: '2026-09-29', from: 1, to: 100, lastUsed: 99 });
    const fresh = queueBlock({ day: '2026-09-29', from: 101, to: 200 });

    expect(blockForDay([fresh, leftover], '2026-09-29')?.from).toBe(1);
  });

  it('never mistakes a receipt block for a day', () => {
    expect(blockForDay([receiptBlock()], '2026-09-29')).toBeNull();
  });
});

describe('updating one block in place', () => {
  it('replaces exactly the block that moved', () => {
    const today = queueBlock({ day: '2026-09-29', from: 1, to: 100 });
    const tomorrow = queueBlock({ day: '2026-09-30', from: 101, to: 200 });

    const updated = replaceBlock([today, tomorrow], { ...today, lastUsed: 1 });

    expect(updated[0]?.lastUsed).toBe(1);
    expect(updated[1]).toBe(tomorrow);
  });
});

describe('a number a device printed itself', () => {
  it('is recorded on the block, and comes back as the next one to print', () => {
    const taken = claim(queueBlock(), 1);

    expect(taken).toEqual({ ok: true, block: queueBlock({ lastUsed: 1 }) });
    expect(taken.ok && nextValue(taken.block)).toBe(2);
  });

  it('refuses a number the block never lent', () => {
    expect(claim(queueBlock({ from: 10, to: 20 }), 9)).toEqual({
      ok: false,
      reason: 'out_of_range',
    });
    expect(claim(queueBlock({ from: 10, to: 20 }), 21)).toEqual({
      ok: false,
      reason: 'out_of_range',
    });
    expect(claim(queueBlock(), 0)).toEqual({ ok: false, reason: 'out_of_range' });
    expect(claim(queueBlock(), 2.5)).toEqual({ ok: false, reason: 'out_of_range' });
  });

  it('refuses a number at or behind the mark, which would be two customers and one ticket', () => {
    const used = queueBlock({ from: 1, to: 100, lastUsed: 5 });

    expect(claim(used, 5)).toEqual({ ok: false, reason: 'already_used' });
    expect(claim(used, 3)).toEqual({ ok: false, reason: 'already_used' });
    expect(claim(used, 6)).toEqual({ ok: true, block: queueBlock({ lastUsed: 6 }) });
  });

  it('refuses to believe a block that does not make sense', () => {
    expect(claim(queueBlock({ from: 10, to: 9 }), 10)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('reports the block that came back as spent through that number, not through the range', () => {
    const taken = claim(queueBlock({ from: 1, to: 100 }), 7);

    expect(taken.ok && spentCount(taken.block)).toBe(7);
    expect(taken.ok && remaining(taken.block)).toBe(93);
    // And the tail still comes back to the shop when the block is reported.
    expect(taken.ok && resumeAt(taken.block)).toBe(7);
  });
});

describe('how big the next block should be', () => {
  it('borrows twice the shop’s busiest day', () => {
    expect(suggestBlockSize({ busiestDaySales: 120, floor: 50 })).toBe(240);
  });

  it('never goes below the floor, so a quiet shop still has numbers to spend', () => {
    expect(suggestBlockSize({ busiestDaySales: 3, floor: 50 })).toBe(50);
  });

  it('caps a freak day, because a huge block freezes the series until it is reported', () => {
    expect(suggestBlockSize({ busiestDaySales: 5_000, floor: 50 })).toBe(1_000);
    expect(suggestBlockSize({ busiestDaySales: 5_000, floor: 50, ceiling: 400 })).toBe(400);
  });
});
