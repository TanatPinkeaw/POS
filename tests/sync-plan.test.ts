// Seam under test: the queue a device holds after an outage (ADR 0019).
//
// Pure, because the two properties that matter are invisible in a browser: the order
// bills are replayed in, and the fact that nothing is ever dropped. A queue that
// quietly gave up on a sale would look exactly like a queue that was empty.
import { describe, expect, it } from 'vitest';

import {
  dueForReplay,
  mayUseServer,
  nextSequence,
  pendingSummary,
  recordFailure,
  replayOrder,
  type QueuedBill,
} from '@/lib/sync-plan';

const NOW = new Date('2026-09-29T09:00:00.000Z');

function bill(overrides: Partial<QueuedBill> = {}): QueuedBill {
  return {
    clientRef: 'ref-1',
    sequence: 1,
    soldAt: NOW,
    soldDay: '2026-09-29',
    lines: [{ productId: 'p-coffee', quantity: 1, unitPrice: 45 }],
    totalThb: 45,
    receivedThb: 45,
    tax: { isVatInvoice: false, vatRatePercent: null, netThb: 45, vatThb: 0 },
    attempts: 0,
    nextAttemptAt: NOW,
    ...overrides,
  };
}

describe('the order the queue is sent in', () => {
  it('follows the device’s own sequence', () => {
    const queue = [bill({ clientRef: 'c', sequence: 3 }), bill({ clientRef: 'a', sequence: 1 }), bill({ clientRef: 'b', sequence: 2 })];

    expect(replayOrder(queue).map((entry) => entry.clientRef)).toEqual(['a', 'b', 'c']);
  });

  it('does not follow the clock, which on a tablet can jump backwards', () => {
    const later = bill({ clientRef: 'second', sequence: 2, soldAt: new Date('2026-09-29T08:00:00.000Z') });
    const earlier = bill({ clientRef: 'first', sequence: 1, soldAt: new Date('2026-09-29T08:30:00.000Z') });

    expect(replayOrder([later, earlier]).map((entry) => entry.clientRef)).toEqual(['first', 'second']);
  });

  it('leaves the queue it was given alone', () => {
    const queue = [bill({ sequence: 2 }), bill({ sequence: 1 })];
    replayOrder(queue);

    expect(queue.map((entry) => entry.sequence)).toEqual([2, 1]);
  });
});

describe('what an automatic attempt may try', () => {
  it('tries a bill that has never been attempted', () => {
    expect(dueForReplay([bill()], NOW)).toHaveLength(1);
  });

  it('waits out a bill that just failed, and keeps the order', () => {
    const failed = recordFailure(bill(), NOW);
    const due = dueForReplay([failed, bill({ clientRef: 'next', sequence: 2 })], NOW);

    expect(due.map((entry) => entry.clientRef)).toEqual([]);
  });

  it('comes back to it once the wait is over', () => {
    const failed = recordFailure(bill(), NOW);
    const later = new Date(NOW.getTime() + 2 * 60_000);

    expect(dueForReplay([failed], later).map((entry) => entry.clientRef)).toEqual(['ref-1']);
  });
});

describe('giving up, which this queue never does', () => {
  it('keeps the bill and counts the attempt', () => {
    const failed = recordFailure(bill({ attempts: 3 }), NOW);

    expect(failed.attempts).toBe(4);
    expect(failed.clientRef).toBe('ref-1');
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('pushes the wait further out the more it has failed', () => {
    const first = recordFailure(bill(), NOW);
    const fifth = recordFailure(bill({ attempts: 4 }), NOW);

    expect(fifth.nextAttemptAt.getTime()).toBeGreaterThan(first.nextAttemptAt.getTime());
  });

  it('never drops anything, however long the device was away', () => {
    let queue = [bill()];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      queue = [recordFailure(queue[0] as QueuedBill, NOW)];
    }

    expect(queue).toHaveLength(1);
    expect(queue[0]?.attempts).toBe(50);
  });
});

describe('the number the next bill printed gets', () => {
  it('starts at one on a device that has never sold offline', () => {
    expect(nextSequence([])).toBe(1);
  });

  it('carries on past the highest it has', () => {
    expect(nextSequence([bill({ sequence: 4 }), bill({ sequence: 9 })])).toBe(10);
  });
});

describe('when the server may touch the shop’s numbers', () => {
  it('only once the device has sent everything it printed', () => {
    expect(mayUseServer([])).toEqual({ allowed: true, message: null });
  });

  it('is refused while a bill is still unsent, with the way out in the message', () => {
    const readiness = mayUseServer([bill(), bill({ clientRef: 'ref-2', sequence: 2 })]);

    expect(readiness.allowed).toBe(false);
    expect(readiness.message).toContain('2');
    expect(readiness.message).toContain('ค้าง');
  });
});

describe('what the till’s banner says', () => {
  it('is empty on a device that has sent everything', () => {
    expect(pendingSummary([], NOW)).toEqual({ count: 0, totalThb: 0, oldestMinutes: null, dueCount: 0 });
  });

  it('adds up what is waiting and how long the oldest has waited', () => {
    const summary = pendingSummary(
      [
        bill({ clientRef: 'old', sequence: 1, totalThb: 45, soldAt: new Date('2026-09-29T08:12:30.000Z') }),
        bill({ clientRef: 'new', sequence: 2, totalThb: 65, soldAt: new Date('2026-09-29T08:59:00.000Z') }),
      ],
      NOW,
    );

    expect(summary.count).toBe(2);
    expect(summary.totalThb).toBe(110);
    // Rounded down: a wait the shop is told about is never longer than it turns out.
    expect(summary.oldestMinutes).toBe(47);
    expect(summary.dueCount).toBe(2);
  });

  it('counts only what the schedule lets it try', () => {
    const summary = pendingSummary([recordFailure(bill(), NOW), bill({ clientRef: 'later', sequence: 2 })], NOW);

    expect(summary.count).toBe(2);
    expect(summary.dueCount).toBe(0);
  });
});
