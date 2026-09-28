// Seam under test: a message waiting to go out, against a real database.
//
// The unit halves (`notify-message`, `notify-retry`) pin what to send and when to
// try again; this file pins what happens to the row, which is where a notification
// is actually lost: a fact written without its message, a message sent twice, a
// worker killed mid-send leaving a row that never comes back, a failure nobody can
// diagnose.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db';
import { ConflictError } from '@/lib/errors';
import { MAX_ATTEMPTS } from '@/lib/notify-retry';
import {
  claimNotifications,
  dueNotificationIds,
  enqueueNotification,
  markFailed,
  markSent,
  outboxHealth,
  type PlannedNotification,
  type QueuedNotification,
} from '@/lib/notify-outbox';

import { resetDatabase, seedPeople } from './helpers/test-db';

beforeEach(async () => {
  await resetDatabase();
  await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const ORDER = '11111111-2222-3333-4444-555555555555';

/** A real order row, because the outbox's foreign key insists on one. */
async function seedOrder(): Promise<string> {
  const order = await prisma.orders.create({
    data: {
      id: ORDER,
      order_number: 'PO-20260928-000001',
      order_type: 'preorder',
      status: 'ready_for_pickup',
      final_amount: 107,
      net_amount: 107,
      vat_amount: 0,
    },
  });
  return order.id;
}

function plan(overrides: Partial<PlannedNotification> = {}): PlannedNotification {
  return {
    kind: 'order_ready',
    channel: 'webhook',
    recipient: '0800000302',
    text: 'ออเดอร์ PO-20260928-000001 พร้อมรับแล้ว แจ้ง PIN 7391 ที่เคาน์เตอร์',
    orderId: ORDER,
    ...overrides,
  };
}

describe('a shop with no channel', () => {
  it('writes nothing for a plan that does not exist', async () => {
    // `null` is the planner's answer when a message cannot be delivered, and the
    // outbox has to treat it as such rather than as an empty message.
    expect(await enqueueNotification(prisma, null)).toBeNull();
    expect(await prisma.notifications.count()).toBe(0);
  });
});

describe('queueing a message', () => {
  it('writes it ready to send, with the text it will be sent as', async () => {
    await seedOrder();

    const queued = await enqueueNotification(prisma, plan());
    const row = await prisma.notifications.findUniqueOrThrow({ where: { id: BigInt(queued!.id) } });

    expect(row.kind).toBe('order_ready');
    expect(row.channel).toBe('webhook');
    expect(row.recipient).toBe('0800000302');
    expect(row.body).toContain('7391');
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(queued?.duplicate).toBe(false);
  });

  it('will not queue the same fact twice, however many times it is asked', async () => {
    await seedOrder();

    const first = await enqueueNotification(prisma, plan());
    const second = await enqueueNotification(prisma, plan());
    const third = await enqueueNotification(prisma, plan());

    expect(second?.duplicate).toBe(true);
    expect(third?.duplicate).toBe(true);
    expect(second?.id).toBe(first?.id);
    expect(await prisma.notifications.count()).toBe(1);
  });

  it('queues two different messages about one order', async () => {
    await seedOrder();

    await enqueueNotification(prisma, plan({ kind: 'order_ready' }));
    await enqueueNotification(prisma, plan({ kind: 'pre_order_placed' }));

    expect(await prisma.notifications.count()).toBe(2);
  });

  it('loses nothing when the transaction it was written in rolls back', async () => {
    /*
     * The reason this table exists at all. The message has to be written in the
     * same transaction as the fact it describes, so a failure has one of two
     * outcomes — order changed and message queued, or neither — and never a
     * customer waiting for a parcel nobody was told about.
     */
    await seedOrder();

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueNotification(tx, plan());
        throw new ConflictError('pretend the order update failed after the enqueue');
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await prisma.notifications.count()).toBe(0);
  });
});

describe('a worker picking up what is due', () => {
  it('claims a row by moving it forward, so a second worker cannot send it too', async () => {
    await seedOrder();
    const queued = await enqueueNotification(prisma, plan());

    const first = await claimNotifications({ ids: [queued!.id] });
    const second = await claimNotifications({ ids: [queued!.id] });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);

    const row = await prisma.notifications.findUniqueOrThrow({ where: { id: BigInt(queued!.id) } });
    // Attempted once, and pushed into the future *before* the send — so a worker
    // killed between claiming and sending leaves a row that comes back rather than
    // one stuck in flight forever.
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves a row alone until its next attempt is due', async () => {
    await seedOrder();
    const queued = await enqueueNotification(prisma, plan());
    await claimNotifications({ ids: [queued!.id] });

    expect(await dueNotificationIds()).toEqual([]);

    // And a worker that runs again later — after the backoff — picks it straight
    // back up, which is the whole point of the schedule.
    const later = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(await dueNotificationIds(later)).toEqual([queued!.id]);
  });

  it('picks up the oldest first, and only what is due', async () => {
    await seedOrder();
    await prisma.orders.create({
      data: {
        id: '22222222-2222-3333-4444-555555555555',
        order_number: 'PO-20260928-000002',
        order_type: 'preorder',
        status: 'ready_for_pickup',
        final_amount: 107,
        net_amount: 107,
        vat_amount: 0,
      },
    });

    const first = await enqueueNotification(prisma, plan());
    const second = await enqueueNotification(
      prisma,
      plan({ orderId: '22222222-2222-3333-4444-555555555555' }),
    );
    await prisma.notifications.update({
      where: { id: BigInt(second!.id) },
      data: { next_attempt_at: new Date(Date.now() + 60 * 60 * 1000) },
    });

    expect(await dueNotificationIds()).toEqual([first!.id]);
  });

  it('returns the message itself, so the sender does not read the row again', async () => {
    await seedOrder();
    const queued = await enqueueNotification(prisma, plan());

    const [claimed] = (await claimNotifications({ ids: [queued!.id] })) as QueuedNotification[];

    expect(claimed?.recipient).toBe('0800000302');
    expect(claimed?.body).toContain('พร้อมรับแล้ว');
    expect(claimed?.channel).toBe('webhook');
    expect(claimed?.attempts).toBe(1);
  });
});

describe('what became of a message', () => {
  it('records delivery, once', async () => {
    await seedOrder();
    const queued = await enqueueNotification(prisma, plan());
    await claimNotifications({ ids: [queued!.id] });

    await markSent(queued!.id);

    const row = await prisma.notifications.findUniqueOrThrow({ where: { id: BigInt(queued!.id) } });
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(await dueNotificationIds()).toEqual([]);
  });

  it('records a failure with its reason, and keeps trying', async () => {
    await seedOrder();
    const queued = await enqueueNotification(prisma, plan());
    await claimNotifications({ ids: [queued!.id] });

   await markFailed(queued!.id, 'connect ECONNREFUSED 127.0.0.1:9');

    const row = await prisma.notifications.findUniqueOrThrow({ where: { id: BigInt(queued!.id) } });
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('connect ECONNREFUSED 127.0.0.1:9');
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('abandons a message that has used up its attempts, keeping the reason', async () => {
    await seedOrder();
    const queued = await enqueueNotification(prisma, plan());

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await claimNotifications({
        ids: [queued!.id],
        now: new Date(Date.now() + attempt * 48 * 60 * 60 * 1000),
      });
      await markFailed(queued!.id, `attempt ${attempt} failed`);
    }

    const row = await prisma.notifications.findUniqueOrThrow({ where: { id: BigInt(queued!.id) } });
    expect(row.status).toBe('abandoned');
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    // The last error survives: an abandoned row with no reason is a row nobody can
    // act on, and it is the only trace of a gateway that was never configured.
    expect(row.last_error).toBe(`attempt ${MAX_ATTEMPTS} failed`);
    expect(row.sent_at).toBeNull();
  });

  it('does not touch a message that is already finished', async () => {
    await seedOrder();
    const queued = await enqueueNotification(prisma, plan());
    await claimNotifications({ ids: [queued!.id] });
    await markSent(queued!.id);

    // A late failure from the same attempt must not turn a delivered message into
    // a failing one, and must not queue it again.
    await markFailed(queued!.id, 'a stale error from a worker that lost the race');

    const row = await prisma.notifications.findUniqueOrThrow({ where: { id: BigInt(queued!.id) } });
    expect(row.status).toBe('sent');
    expect(row.last_error).toBeNull();
  });
});

describe('the owner’s view of the queue', () => {
  it('counts what is waiting, what is due, and what has given up', async () => {
    await seedOrder();
    const queued = await enqueueNotification(prisma, plan());
    await prisma.notifications.update({
      where: { id: BigInt(queued!.id) },
      data: { next_attempt_at: new Date(Date.now() + 60 * 60 * 1000) },
    });

    expect(await outboxHealth()).toEqual({ pending: 1, dueNow: 0, abandoned: 0 });

    await prisma.notifications.update({
      where: { id: BigInt(queued!.id) },
      data: { status: 'abandoned', attempts: MAX_ATTEMPTS, last_error: 'wrong URL' },
    });

    expect(await outboxHealth()).toEqual({ pending: 0, dueNow: 0, abandoned: 1 });
  });
});

describe('the guarantees the database keeps', () => {
  it('refuses a message that claims delivery without a time', async () => {
    await seedOrder();

    await expect(
      prisma.notifications.create({
        data: { kind: 'order_ready', channel: 'webhook', recipient: '0800000001', body: 'x', status: 'sent', attempts: 1 },
      }),
    ).rejects.toThrow();
  });

  it('refuses an abandoned message with no reason', async () => {
    await seedOrder();

    await expect(
      prisma.notifications.create({
        data: { kind: 'order_ready', channel: 'webhook', recipient: '0800000001', body: 'x', status: 'abandoned', attempts: 2 },
      }),
    ).rejects.toThrow();
  });

  it('refuses a finished message that was never attempted', async () => {
    await seedOrder();

    await expect(
      prisma.notifications.create({
        data: { kind: 'order_ready', channel: 'webhook', recipient: '0800000001', body: 'x', status: 'sent', attempts: 0, sent_at: new Date() },
      }),
    ).rejects.toThrow();
  });
});
