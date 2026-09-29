/**
 * A range of numbers the shop lends to a device — ADR 0019.
 *
 * A browser cannot bump `shops.receipt_running_number` inside the sale's
 * transaction, so the shop advances its own counter past a range in advance and the
 * device spends that range while it is alone. Everything about *which* number comes
 * next therefore lives here, pure — the same split `queue-number.ts` has for what a
 * number looks like: a rule that ends up on a government document, checkable without
 * a server, a browser or a clock.
 *
 * What this module deliberately does **not** own: the printed shape of a number
 * (`queue-number.ts`, and `formatReceiptNumber` in `shop-view.ts`), the day rollover
 * of the shop's online counter (`allocateQueueNumber` decides that inside the one
 * statement that bumps it), and any storage at all.
 *
 * `resumeAt` is the function that makes gaplessness survive a browser. The shop's
 * counter is set to the last number the device *actually printed*, never to the end
 * of the range it borrowed — so the untouched tail of a block comes back as the next
 * numbers issued online instead of becoming holes nobody can explain to an auditor.
 */

/** Which series a block belongs to. The two have separate counters on the shop row. */
export type NumberKind = 'receipt' | 'queue';

/**
 * The largest range a device may borrow in one go.
 *
 * A borrowed block freezes the series it came from until it is reported, so an
 * unbounded one is a mistake that stops a shop selling rather than a generous loan.
 * Two thousand is several times the busiest day this system has been sized for, which
 * is what makes hitting this ceiling a bug rather than a busy afternoon.
 */
export const MAX_BLOCK_SIZE = 2_000;

/**
 * One borrowed range.
 *
 * `day` is the Bangkok day a call-number block is *for*, and null on the receipt
 * series, which is numbered per year rather than per day. It is stored rather than
 * derived because it is what the till compares its own clock against: a device whose
 * clock has drifted must not spend tomorrow's numbers on today's customers, and the
 * block is what tells it so.
 *
 * `lastUsed` is nullable rather than 0 because "untouched" and "used up to zero" are
 * different facts, and only one of them is true of a block nobody has printed from.
 */
export interface NumberBlock {
  readonly kind: NumberKind;
  readonly day: string | null;
  readonly from: number;
  readonly to: number;
  readonly lastUsed: number | null;
}

/** Why a block could not be spent. All three are programming mistakes, not refusals. */
export type BlockRefusal = 'malformed' | 'exhausted';

function isPositiveWholeNumber(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Whether a block is internally consistent.
 *
 * Called at the edges rather than trusted: the values arrive from a device that has
 * been asleep in a shop, and a range whose end precedes its start would silently
 * produce a negative count of remaining numbers — a block that looks exhausted and a
 * shop that cannot sell, with nothing in the log to say why.
 */
export function isWellFormedBlock(block: NumberBlock): boolean {
  if (!isPositiveWholeNumber(block.from) || !isPositiveWholeNumber(block.to)) {
    return false;
  }
  if (block.to < block.from) {
    return false;
  }
  if (block.lastUsed === null) {
    return true;
  }
  return isPositiveWholeNumber(block.lastUsed) && block.lastUsed >= block.from && block.lastUsed <= block.to;
}

/** How many numbers the range holds, used or not. */
export function blockSize(block: NumberBlock): number {
  return block.to - block.from + 1;
}

/**
 * The number this block would hand out next, or null when it is spent.
 *
 * Null is not an error: a device whose block ran out mid-queue is the case ADR 0019
 * decided to refuse a tax invoice for rather than invent a number.
 */
export function nextValue(block: NumberBlock): number | null {
  const next = (block.lastUsed ?? block.from - 1) + 1;
  return next <= block.to ? next : null;
}

/** How many numbers are left to hand out. Zero means spent. */
export function remaining(block: NumberBlock): number {
  return block.to - (block.lastUsed ?? block.from - 1);
}

/** How many numbers have been handed out — what the device owes an account of. */
export function spentCount(block: NumberBlock): number {
  return block.lastUsed === null ? 0 : block.lastUsed - block.from + 1;
}

/**
 * Hands out the next number, returning the block as it now stands.
 *
 * The updated block comes back rather than being mutated, so the caller that decides
 * whether a sale may happen is the same call that consumes the number: a refused sale
 * must burn nothing, and the way to guarantee that is for the refusal path never to
 * reach this function (see `decideOfflineSale`).
 */
export function spend(
  block: NumberBlock,
): { ok: true; value: number; block: NumberBlock } | { ok: false; reason: BlockRefusal } {
  if (!isWellFormedBlock(block)) {
    return { ok: false, reason: 'malformed' };
  }
  const value = nextValue(block);
  if (value === null) {
    return { ok: false, reason: 'exhausted' };
  }
  return { ok: true, value, block: { ...block, lastUsed: value } };
}

/**
 * What the shop's counter must be set to when this block is reported.
 *
 * `from − 1` for a block nobody printed from, so a device that borrowed numbers and
 * never used them gives them all back. This is the opposite of "the counter is
 * wherever the range ended", and it is the whole reason the series stays gapless.
 */
export function resumeAt(block: NumberBlock): number {
  return block.lastUsed ?? block.from - 1;
}

/**
 * The open block of one series, for one day. `day` is null for the receipt series.
 *
 * Two shapes hide behind one function, and the difference is why it takes a day at all:
 * the receipt series is a single range that only ever moves forward, while the call
 * numbers of two different days are **independent series** — each starts at 1 again, so
 * "1..100 today" and "1..100 tomorrow" are not one range and must never be compared as
 * one. The lowest matching block wins, so a leftover unreported block of a day is spent
 * before the fresh one beside it.
 */
export function openBlockFor(
  blocks: readonly NumberBlock[],
  kind: NumberKind,
  day: string | null,
): NumberBlock | null {
  const matching = blocks.filter(
    (block) => block.kind === kind && (kind === 'receipt' || block.day === day),
  );
  if (matching.length === 0) {
    return null;
  }
  return matching.reduce((low, block) => (block.from < low.from ? block : low));
}

/**
 * The call-number block that belongs to one Bangkok day, or null when the device is
 * holding none for it.
 *
 * A device keeps today's and tomorrow's, which is what lets a shop cross midnight
 * without a connection; a day it holds no block for is a bill with no call number, and
 * the sync flags it (ADR 0019 decision 4).
 */
export function blockForDay(blocks: readonly NumberBlock[], day: string): NumberBlock | null {
  return openBlockFor(blocks, 'queue', day);
}

/**
 * Whether this block's report may move the shop's counter.
 *
 * Only the *lowest* open block of its series may — and for call numbers, "its series"
 * means its own day, because the days are independent. Reporting a later block of the
 * same range first would set the counter past numbers an earlier block may still be
 * spending, and the hole that leaves is exactly what the whole protocol exists to
 * prevent. So a device whose report is out of order is told to report the earlier block
 * first rather than being believed.
 */
export function canReport(block: NumberBlock, openBlocks: readonly NumberBlock[]): boolean {
  const sameSeries = openBlocks.filter(
    (candidate) =>
      candidate.kind === block.kind &&
      (block.kind === 'receipt' || candidate.day === block.day),
  );
  if (sameSeries.length === 0) {
    return false;
  }
  return openBlockFor(sameSeries, block.kind, block.day)?.from === block.from;
}

/** Replaces one block of a series by its `from`, leaving the others alone. */
export function replaceBlock(
  blocks: readonly NumberBlock[],
  updated: NumberBlock,
): NumberBlock[] {
  return blocks.map((block) =>
    block.kind === updated.kind && block.from === updated.from && block.day === updated.day
      ? updated
      : block,
  );
}

/**
 * How many numbers to borrow next time.
 *
 * Twice the busiest day the device has seen, with a floor, because the only lever a
 * shop has when a block runs out mid-queue is having borrowed a bigger one — a block
 * is cheap while the till is online and a refusal at the counter is not. The ceiling
 * exists so a freak day (an import, a mis-keyed sale) cannot freeze a series for
 * weeks: a huge block is still a block nobody else may issue from until it is
 * reported.
 */
export function suggestBlockSize(input: {
  busiestDaySales: number;
  floor: number;
  ceiling?: number;
}): number {
  const ceiling = input.ceiling ?? 1000;
  const wanted = Math.max(input.floor, input.busiestDaySales * 2);
  return Math.min(ceiling, Math.ceil(wanted));
}
