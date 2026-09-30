/**
 * The bills a device is holding, and the order it sends them in — ADR 0019.
 *
 * Pure, and separate from the store that keeps them, for the reason the outbox is
 * separate from `notify-retry.ts`: the queue is a table on a tablet and the order and
 * the schedule are policy, and policy decided inside a browser hook can only be tested
 * by clicking through an outage.
 *
 * Three decisions live here, each with a failure mode that is invisible until it
 * matters:
 *
 * 1. **The replay order is the device's own sequence, never its clock.** A tablet's
 *    clock jumps — NTP after a week asleep, somebody setting it by hand — and two
 *    bills that swap places are two call numbers filed in the wrong order, in the one
 *    series the shop is not allowed to reorder.
 * 2. **The retry schedule is reused, the abandon rule is not.** `nextAttemptAt` comes
 *    from `notify-retry.ts` so a second backoff does not grow here, but
 *    `isAbandoned` deliberately does not: a message can be given up on, and a sale
 *    cannot. The queue shrinks only when the server has the money.
 * 3. **A manual send ignores the schedule.** The backoff exists to stop a device
 *    hammering a server that is down; it must never stop a cashier who can see the
 *    network is back.
 */
import { nextAttemptAt } from './notify-retry';
import type { OfflineSaleLine } from './offline-sale-rules';

/**
 * A bill closed with no connection, waiting to be sent.
 *
 * `sequence` is assigned by the device when the slip is printed and never changes. It
 * is what the numbers were handed out in the order of, which is why it is the replay
 * order rather than `soldAt`.
 */
export interface QueuedBill {
  readonly clientRef: string;
  readonly sequence: number;
  /** The device's clock at the sale — which day the books have to file it under. */
  readonly soldAt: Date;
  /** The Bangkok day as the device computed it, kept so a disagreement is visible. */
  readonly soldDay: string;
  /**
   * What was sold, at the prices the device charged. Priced rather than plain
   * quantity-and-product because the customer paid *these* figures: a queue that carried
   * only what was sold would let the replay re-price the bill from a catalogue that has
   * moved on since, which is money quietly disagreeing with a slip.
   */
  readonly lines: readonly OfflineSaleLine[];
  /** What the customer actually paid, for the banner that says what is waiting. */
  readonly totalThb: number;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
}

/** The order the queue is sent in: oldest sequence first. */
export function replayOrder(queue: readonly QueuedBill[]): QueuedBill[] {
  return [...queue].sort((left, right) => left.sequence - right.sequence);
}

/**
 * What an automatic pass may try now.
 *
 * A bill that failed a moment ago is not due yet; one that has never been tried is.
 * The queue is filtered rather than reordered, so the schedule can never make two
 * bills change places.
 */
export function dueForReplay(queue: readonly QueuedBill[], now: Date): QueuedBill[] {
  return replayOrder(queue).filter((bill) => bill.nextAttemptAt.getTime() <= now.getTime());
}

/**
 * Whether the server may touch the shop's series for this device right now.
 *
 * One predicate with two callers, because they are one fact: a number that has been
 * printed but not yet recorded is a hole in the series the moment anything takes a
 * number after it. So a device holding unsent bills **does not sell through the
 * server and does not report its usage** — it keeps selling offline, extending the
 * queue, until the queue is empty.
 *
 * That rule is what makes a report safe. A report says "I counted through N", and N is
 * only true if every number up to N is on the server as a bill; reporting from a device
 * that is still holding bills would hand the shop back a range whose middle is missing.
 *
 * The message is Thai and names the way out, because the till shows it: a cashier who
 * is told "ส่งบิลที่ค้างก่อน" can act on it, and one who is told "offline" cannot.
 */
export function mayUseServer(queue: readonly QueuedBill[]): {
  allowed: boolean;
  message: string | null;
} {
  if (queue.length === 0) {
    return { allowed: true, message: null };
  }
  return {
    allowed: false,
    message:
      `มีบิลค้างส่ง ${queue.length} ใบ — ต้องส่งให้ครบก่อน ` +
      'ไม่งั้นเลขบิลจะขาดช่วง',
  };
}

/** The sequence to give the next bill printed on this device. */
export function nextSequence(queue: readonly QueuedBill[]): number {
  return queue.reduce((highest, bill) => Math.max(highest, bill.sequence), 0) + 1;
}

/**
 * The label a device-printed slip carries until the shop's own number reaches it.
 *
 * A bill closed offline has no `PO-…` number yet — the server mints that, and phase 4 is
 * where it arrives. Printing nothing where a customer expects a reference is worse than
 * printing this: `OFF-20260929-003` says the three things an operator needs — the day,
 * that it has not been sent, and which bill on this device it was. It also gives the
 * replay something to match against when the server's own number comes back.
 */
export function offlineOrderLabel(soldDay: string, sequence: number): string {
  return `OFF-${soldDay.replace(/-/g, '')}-${String(sequence).padStart(3, '0')}`;
}

/**
 * One attempt that did not land: the bill goes back in the queue, later.
 *
 * The bill is returned with more attempts and a pushed-back schedule, and that is the
 * whole effect — nothing is dropped, ever. A device that has been offline for a week
 * comes back with every bill it ever printed.
 */
export function recordFailure(bill: QueuedBill, now: Date): QueuedBill {
  const attempts = bill.attempts + 1;
  return { ...bill, attempts, nextAttemptAt: nextAttemptAt({ attempts, now }) };
}

export interface PendingSummary {
  readonly count: number;
  readonly totalThb: number;
  /** How long the oldest unsent bill has been waiting, rounded down to minutes. */
  readonly oldestMinutes: number | null;
  /** How many an automatic pass would try right now. */
  readonly dueCount: number;
}

/**
 * What the till's banner says.
 *
 * `oldestMinutes` is in there because "ค้าง 3 ใบ" is not alarming on a two-minute
 * outage and is alarming after an hour, and the screen cannot tell the difference
 * without it. Rounding down, because a wait a shop is told about is never longer than
 * it turns out to be.
 */
export function pendingSummary(
  queue: readonly QueuedBill[],
  now: Date,
): PendingSummary {
  const oldest = queue.reduce<Date | null>(
    (earliest, bill) =>
      earliest === null || bill.soldAt.getTime() < earliest.getTime() ? bill.soldAt : earliest,
    null,
  );

  return {
    count: queue.length,
    totalThb: queue.reduce((sum, bill) => sum + bill.totalThb, 0),
    oldestMinutes:
      oldest === null ? null : Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 60_000)),
    dueCount: dueForReplay(queue, now).length,
  };
}
