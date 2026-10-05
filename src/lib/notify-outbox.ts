/**
 * The outbox: messages written in the transaction that made them true.
 *
 * A dispatcher, not a sender. It answers "what is due", claims it in a way that
 * two workers cannot both claim, and records the outcome — and it knows nothing
 * about HTTP, LINE or SMS. The transport lives in `notify-channel.ts`, so a test
 * can exercise every state this table can be in without a network, and adding a
 * third channel is not a change here.
 *
 * Two properties are the reason this is a table rather than a `fetch` in the
 * request path:
 *
 *   * **The message is on disk before anything tries to send it**, in the same
 *     transaction as the order update. A process killed between the two loses
 *     nothing; a `fetch` in the handler loses the customer's notification when the
 *     connection drops.
 *   * **Claiming is a conditional UPDATE.** Moving `next_attempt_at` forward is
 *     what marks a row as taken — so a worker killed mid-send leaves a row that
 *     comes back on a later pass, rather than one stuck in flight forever, and a
 *     worker started twice sends nothing twice.
 */
import { prisma } from './db';
import { ConflictError } from './errors';
import type { Db } from './inventory';
import type { NotificationChannel, PlannedNotification } from './notify-message';
import { isAbandoned, nextAttemptAt } from './notify-retry';

export type { PlannedNotification };

/** Re-exported so callers do not have to know the planner's file to name a plan. */
export type { NotificationChannel };

/** A message as the worker needs it: who, on what, and what to say. */
export interface QueuedNotification {
  id: string;
  kind: string;
  channel: NotificationChannel;
  recipient: string;
  body: string;
  /** 1 on the first attempt, which is also what the retry schedule is keyed on. */
  attempts: number;
}

export interface EnqueueResult {
  id: string;
  /** True when this exact fact was already queued; the existing row is returned. */
  duplicate: boolean;
}

/**
 * Writes a planned message, or nothing when the plan is nothing.
 *
 * Takes the transaction handle when it is called from inside one — which is the
 * only way to call it for a fact that is also being written. A duplicate is
 * reported rather than raised, because the caller is a route that may legitimately
 * be retried.
 */
export async function enqueueNotification(
  db: Db,
  plan: PlannedNotification | null,
): Promise<EnqueueResult | null> {
  if (plan === null) {
    return null;
  }

  const existing = await db.notifications.findFirst({
    where: { kind: plan.kind, order_id: plan.orderId },
    select: { id: true },
  });
  if (existing) {
    return { id: existing.id.toString(), duplicate: true };
  }

  const created = await db.notifications.create({
    data: {
      kind: plan.kind,
      channel: plan.channel,
      recipient: plan.recipient,
      body: plan.text,
      order_id: plan.orderId,
    },
    select: { id: true },
  });

  return { id: created.id.toString(), duplicate: false };
}

/**
 * The ids of messages that are due, oldest first.
 *
 * Ids rather than rows on purpose: between this read and the claim another worker
 * may take the same row, and the claim is where that is settled. Selecting rows
 * here would make the read look authoritative when it is not.
 */
export async function dueNotificationIds(now: Date = new Date(), limit = 20): Promise<string[]> {
  const rows = await prisma.notifications.findMany({
    where: { status: 'pending', next_attempt_at: { lte: now } },
    orderBy: { next_attempt_at: 'asc' },
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id.toString());
}

/**
 * Takes ownership of the given messages, or as many of them as this worker wins.
 *
 * One conditional `UPDATE` per row, and the count is the answer: 0 means somebody
 * else has it, or it is no longer due. The attempt is counted and the next attempt
 * scheduled *here*, before the send, so the row is never in flight without a
 * deadline attached to it.
 */
export async function claimNotifications(input: {
  ids: string[];
  now?: Date;
}): Promise<QueuedNotification[]> {
  const now = input.now ?? new Date();
  const claimed: QueuedNotification[] = [];

  for (const id of input.ids) {
    const existing = await prisma.notifications.findUnique({
      where: { id: BigInt(id) },
      select: { attempts: true },
    });
    if (!existing) {
      continue;
    }

    const attempts = existing.attempts + 1;
    const result = await prisma.notifications.updateMany({
      where: { id: BigInt(id), status: 'pending', next_attempt_at: { lte: now } },
      data: { attempts, next_attempt_at: nextAttemptAt({ attempts, now }) },
    });
    if (result.count !== 1) {
      continue;
    }

    const row = await prisma.notifications.findUniqueOrThrow({
      where: { id: BigInt(id) },
      select: {
        id: true,
        kind: true,
        channel: true,
        recipient: true,
        body: true,
        attempts: true,
      },
    });

    claimed.push({
      id: row.id.toString(),
      kind: row.kind,
      channel: row.channel as NotificationChannel,
      recipient: row.recipient,
      body: row.body,
      attempts: row.attempts,
    });
  }

  return claimed;
}

/** The message went out. Only ever applied to a row that is still pending. */
export async function markSent(id: string, now: Date = new Date()): Promise<void> {
  /*
   * `status: 'pending'` in the filter is deliberate rather than sloppy: a worker
   * that lost a race reports its outcome against a row somebody else already
   * finished, and the conditional update makes that report a no-op instead of a
   * rewrite of the winner's result.
   */
  await prisma.notifications.updateMany({
    where: { id: BigInt(id), status: 'pending' },
    data: { status: 'sent', sent_at: now, last_error: null },
  });
}

/**
 * The message did not go out, and why.
 *
 * The next attempt is already scheduled by the claim, so this only records the
 * error — and abandons the row once the schedule is exhausted. Abandoning is the
 * point at which a misconfigured gateway stops being retried and starts being
 * visible.
 */
export async function markFailed(id: string, error: string, now: Date = new Date()): Promise<void> {
  const row = await prisma.notifications.findUnique({
    where: { id: BigInt(id) },
    select: { attempts: true, status: true },
  });
  if (!row || row.status !== 'pending') {
    return;
  }

  const message = error.slice(0, 500);
  await prisma.notifications.updateMany({
    where: { id: BigInt(id), status: 'pending' },
    data: isAbandoned(row.attempts)
      ? { status: 'abandoned', last_error: message }
      : { last_error: message, next_attempt_at: nextAttemptAt({ attempts: row.attempts, now }) },
  });
}

/**
 * What the owner needs to know about delivery, in three numbers.
 *
 * The dashboard shows this only when something is wrong, and `abandoned` is the
 * number that says so: pending messages are normal, and a pile of them that have
 * given up is a shop whose messages are going nowhere.
 */
export async function outboxHealth(
  now: Date = new Date(),
): Promise<{ pending: number; dueNow: number; abandoned: number }> {
  const [pending, dueNow, abandoned] = await Promise.all([
    prisma.notifications.count({ where: { status: 'pending' } }),
    prisma.notifications.count({ where: { status: 'pending', next_attempt_at: { lte: now } } }),
    prisma.notifications.count({ where: { status: 'abandoned' } }),
  ]);

  return { pending, dueNow, abandoned };
}

/** The messages that gave up, newest first, with the error that stopped them. */
export async function listAbandonedNotifications(limit = 5): Promise<
  { id: string; kind: string; recipient: string; lastError: string | null; attempts: number }[]
> {
  const rows = await prisma.notifications.findMany({
    where: { status: 'abandoned' },
    orderBy: { created_at: 'desc' },
    take: limit,
    select: { id: true, kind: true, recipient: true, last_error: true, attempts: true },
  });

  return rows.map((row) => ({
    id: row.id.toString(),
    kind: row.kind,
    recipient: row.recipient,
    lastError: row.last_error,
    attempts: row.attempts,
  }));
}

/**
 * Puts an abandoned message back in the queue.
 *
 * The one repair a shop needs after fixing a URL: without it, the messages that
 * gave up are a permanent record of a mistake that has already been corrected.
 * The attempt count resets, because the reason it failed is gone.
 */
export async function requeueNotification(id: string, now: Date = new Date()): Promise<void> {
  const result = await prisma.notifications.updateMany({
    where: { id: BigInt(id), status: 'abandoned' },
    data: { status: 'pending', attempts: 0, last_error: null, next_attempt_at: now },
  });
  if (result.count !== 1) {
    throw new ConflictError(
      'การแจ้งนี้ไม่ได้ค้างเสีย จึงไม่มีอะไรให้ส่งซ้ำ',
      'NOTIFICATION_NOT_ABANDONED',
    );
  }
}
