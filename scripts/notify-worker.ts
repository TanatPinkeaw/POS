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
 * Exit code is 1 when a message was abandoned in this pass — the one outcome a
 * shop has to hear about, because it means the gateway it configured is not the
 * one that is answering — and 0 otherwise, including when a message merely failed
 * and will be retried. A cron job that mails on non-zero therefore mails on "your
 * messages are going nowhere" and not on "the gateway hiccuped".
 */
import { loadEnv } from './harness';
import { prisma } from '../src/lib/db';

import { deliverNotification, readChannelConfig } from '../src/lib/notify-channel';
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

async function pass(): Promise<{ sent: number; failed: number; abandoned: number }> {
  const config = readChannelConfig();
  if (config === null) {
    /*
     * Nothing to do, and not an error: a shop that has not configured delivery
     * gets its alerts in the app. Its rows are only written by a shop that *has*
     * configured one, so an empty queue here is the expected state.
     */
    return { sent: 0, failed: 0, abandoned: 0 };
  }

  const ids = await dueNotificationIds(new Date(), limit);
  const claimed = await claimNotifications({ ids });

  let sent = 0;
  let failed = 0;

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

  const health = await outboxHealth();
  return { sent, failed, abandoned: health.abandoned };
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

    if (result.sent + result.failed > 0) {
      console.log(`  • pass: sent ${result.sent}, failed ${result.failed}`);
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000));
  } while (watch);
}

void main();
