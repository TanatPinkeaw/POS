/**
 * `npm run notify:worker` — drain the notification outbox.
 *
 * Everything that decides *what* to send lives in `src/lib/notify-message.ts`, and
 * everything that decides *when* lives in `src/lib/notify-retry.ts`. This file is
 * only the part that cannot be tested that way: a loop, a clock, and a report a
 * person can read.
 *
 * Usage:
 *   npm run notify:worker               drain what is due, then exit (for cron)
 *   npm run notify:worker -- --watch    keep going, every 30 seconds
 *   npm run notify:worker -- --limit 50 how many rows one pass may claim
 *
 * Two queues drain here, and they are different shapes: the outbox's rows (one message, one
 * recipient, retried on a schedule) and campaigns' batches (one request to up to 500 people,
 * tried exactly once). They also have different preconditions — `NOTIFY_CHANNEL` for the
 * first, a LINE channel access token for the second — which is why each checks its own. The
 * campaign half is ADR 0032 §7: see `sendCampaigns` for why a failure is recorded and never
 * retried.
 *
 * Exit code is 1 when a message was abandoned in this pass — the one outcome a
 * shop has to hear about, because it means the gateway it configured is not the
 * one that is answering — and 0 otherwise, including when a message merely failed
 * and will be retried. A cron job that mails on non-zero therefore mails on "your
 * messages are going nowhere" and not on "the gateway hiccuped".
 */
import { loadEnv } from './harness';
import { prisma } from '../src/lib/db';

import {
  abandonStalledCampaignBatches,
  claimCampaignBatch,
  dueCampaignBatches,
  markCampaignBatchFailed,
  markCampaignBatchSent,
} from '../src/lib/line-campaigns';
import { enqueueDuePickupReminders } from '../src/lib/orders';
import {
  deliverCampaignBatch,
  deliverNotification,
  readChannelConfig,
  readLineChannelToken,
} from '../src/lib/notify-channel';
import {
  claimNotifications,
  dueNotificationIds,
  markFailed,
  markSent,
  outboxHealth,
} from '../src/lib/notify-outbox';

loadEnv();

const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const limitIndex = argv.indexOf('--limit');
const limit = limitIndex === -1 ? 20 : Number(argv[limitIndex + 1] ?? '20');

/** How long a `--watch` worker sleeps between passes when there is nothing due. */
const IDLE_SECONDS = 30;

async function pass(): Promise<{
  sent: number;
  failed: number;
  abandoned: number;
  reminders: number;
  campaignBatches: number;
  campaignFailures: number;
}> {
  /*
   * The two queues have different preconditions and each checks its own, which is why this is
   * not one early return. The outbox needs `NOTIFY_CHANNEL` — a shop that has not configured
   * delivery gets its alerts in the app, and an empty queue is the expected state there. A
   * campaign needs a LINE token, which a shop whose own alerts go to a webhook can hold just
   * as well (ADR 0032 §6).
   */
  const config = readChannelConfig();

  let sent = 0;
  let failed = 0;

  if (config !== null) {
    const ids = await dueNotificationIds(new Date(), limit);
    const claimed = await claimNotifications({ ids });

    for (const notification of claimed) {
      try {
        await deliverNotification(notification, config);
        await markSent(notification.id);
        sent += 1;
        console.log(`  ✓ ${notification.kind} → ${notification.recipient}`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await markFailed(notification.id, reason);
        failed += 1;
        console.error(`  ✗ ${notification.kind} → ${notification.recipient}: ${reason}`);
      }
    }
  }

  /*
   * The reminder sweep (ADR 0035) sits between the two queues because it *feeds* the
   * first one: it writes `order_reminder` rows and this same pass may deliver them. Its
   * own precondition is `NOTIFY_CHANNEL=line`, checked inside rather than here — a shop
   * whose own alerts go to a webhook can still have LINE-bound customers, and a shop with
   * no channel at all simply gets zero.
   *
   * Bounded per pass (`take: 100` inside, and orders already reminded are excluded by the
   * query), so a worker started after a week of downtime writes one batch and moves on
   * rather than stalling the queue behind a backlog of reminders.
   */
  const reminders = await enqueueDuePickupReminders();
  if (reminders.queued > 0) {
    console.log(`  • queued ${reminders.queued} pickup reminder(s)`);
  }

  const campaigns = await sendCampaigns();

  const health = await outboxHealth();
  return {
    sent,
    failed,
    abandoned: health.abandoned,
    reminders: reminders.queued,
    campaignBatches: campaigns.sent,
    campaignFailures: campaigns.failed,
  };
}

/**
 * Delivers the campaign batches that have not been tried yet (ADR 0032 §7).
 *
 * Two things happen in this order, and the first is the one worth explaining.
 *
 * **Stalled batches are closed first.** A worker killed between stamping a batch and writing
 * its outcome leaves a row that says "attempted, no answer" — and since a batch is sent at
 * most once, nothing will ever pick it up again. `abandonStalledCampaignBatches` records that
 * ambiguity on the row and lets the campaign settle, which is what makes the case visible
 * instead of a campaign that reads `pending` forever.
 *
 * **Then the due ones go out, one request each.** LINE's multicast takes at most 500 ids and
 * counts the message once per recipient, so a batch is exactly one request and its failure is
 * recorded on its own row with LINE's own words. Nothing is retried: LINE offers no
 * idempotency key, and a promotion delivered twice to five hundred people is worse than one an
 * admin has to write again.
 */
async function sendCampaigns(): Promise<{ sent: number; failed: number }> {
  const token = readLineChannelToken();
  if (token === null) {
    // No LINE channel token: there is nowhere for a promotion to go, and the campaigns that
    // exist are the shop's own record of what it decided to send.
    return { sent: 0, failed: 0 };
  }

  const stalled = await abandonStalledCampaignBatches();
  if (stalled > 0) {
    console.error(
      `  ! ${stalled} campaign batch(es) had no outcome recorded — marked as unknown, not retried`,
    );
  }

  const due = await dueCampaignBatches(limit);
  let sent = 0;
  let failed = 0;

  for (const batch of due) {
    /*
     * The claim is the at-most-once gate: a second worker started at the same moment reads
     * the same due list and loses this statement. Everything after it is one attempt.
     */
    if (!(await claimCampaignBatch(batch.id))) {
      continue;
    }
    try {
      await deliverCampaignBatch({
        recipientIds: batch.recipientIds,
        body: batch.body,
        imageUrl: batch.imageUrl,
      });
      await markCampaignBatchSent(batch.id);
      sent += 1;
      console.log(`  ✓ campaign batch ${batch.batchIndex} → ${batch.recipientIds.length} people`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await markCampaignBatchFailed(batch.id, reason);
      failed += 1;
      console.error(`  ✗ campaign batch ${batch.batchIndex}: ${reason}`);
    }
  }

  return { sent, failed };
}

async function main(): Promise<void> {
  console.log('');
  console.log('POS — notification worker');
  console.log('=========================');

  const config = readChannelConfig();
  console.log(
    config === null
      ? '\nNo channel configured (set NOTIFY_CHANNEL); nothing to send.'
      : `\nChannel: ${config.channel}`,
  );

  do {
    const result = await pass();

    if (!watch) {
      console.log(
        `\nSent ${result.sent}, failed ${result.failed}, abandoned in total ${result.abandoned}`,
      );
      if (result.reminders > 0) {
        console.log(`Pickup reminders queued: ${result.reminders}`);
      }
      if (result.campaignBatches + result.campaignFailures > 0) {
        console.log(
          `Campaign batches: sent ${result.campaignBatches}, failed ${result.campaignFailures}`,
        );
      }
      if (result.abandoned > 0) {
        console.error(
          '\nSomething is abandoned: those messages will not be tried again. Check the gateway',
        );
        console.error('URL and secret, fix them, then re-run with `--watch` after requeueing.');
      }
      // Let database/socket handles close before Node tears down its event loop;
      // forced exit can abort libuv on Windows even after every message was sent.
      process.exitCode = result.abandoned > 0 ? 1 : 0;
      await prisma.$disconnect();
      return;
    }

    if (
      result.sent +
        result.failed +
        result.reminders +
        result.campaignBatches +
        result.campaignFailures >
      0
    ) {
      console.log(
        `  • pass: sent ${result.sent}, failed ${result.failed}, reminders ${result.reminders}, campaign batches ${result.campaignBatches}/${result.campaignBatches + result.campaignFailures}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000));
  } while (watch);
}

void main();
