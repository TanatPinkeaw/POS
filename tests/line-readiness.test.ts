// Seam under test: whether a shop's LINE doors are actually open, from the environment
// alone (ADR 0035).
//
// The bug this file exists for was not a crash. `npm run line:wizard` printed
// "push ลูกค้า: พร้อม" whenever a channel secret and a push token were set, while the
// customer's "order ready" message was gated on `NOTIFY_CHANNEL=line` — a third value
// the wizard never read. A shop could therefore believe it was notifying customers and
// send nothing, with no error anywhere and no row in the outbox to find.
//
// So the cases below are not "does each key exist". They are the four states a shop is
// actually in: a token without the channel, a channel without a token, a webhook-only
// shop, and a shop with nothing set at all.
import { describe, expect, it } from 'vitest';

import {
  OUTBOX_STALL_MINUTES,
  customerPushDoor,
  lineReadiness,
  outboxStalled,
} from '@/lib/line-readiness';

/** A deployment where every LINE door is open. */
const COMPLETE = {
  NOTIFY_CHANNEL: 'line',
  NOTIFY_LINE_TOKEN: 'channel-token',
  LINE_MESSAGING_CHANNEL_SECRET: 'channel-secret',
  LINE_LOGIN_CHANNEL_ID: '1234567890',
  LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
  LINE_LIFF_ID: '2000000000-abcdefgh',
} as const;

function door(env: Record<string, string | undefined>, id: string) {
  const found = lineReadiness(env).find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`no door ${id}`);
  }
  return found;
}

describe('the customer “ready” door', () => {
  it('is ready only when the channel, the token and the webhook secret are all set', () => {
    expect(customerPushDoor(COMPLETE).state).toBe('ready');
    expect(customerPushDoor(COMPLETE).missing).toEqual([]);
  });

  it('is blocked when the token and secret exist but NOTIFY_CHANNEL is not `line`', () => {
    // The measured failure this module was written for: the old wizard called this ready.
    const status = door(
      { NOTIFY_LINE_TOKEN: 'channel-token', LINE_MESSAGING_CHANNEL_SECRET: 'secret' },
      'customer_push',
    );

    expect(status.state).toBe('blocked');
    expect(status.missing).toEqual(['NOTIFY_CHANNEL=line']);
    // The sentence has to say what does *not* happen, not merely name a variable.
    expect(status.sentence).toContain('ไม่ออก');
  });

  it('treats a webhook shop as a shop that cannot push on LINE', () => {
    // `webhook` is a valid answer to "where do the shop's alerts go"; it is not a LINE
    // push channel, and the customer's message would still not leave.
    const status = door(
      { ...COMPLETE, NOTIFY_CHANNEL: 'webhook' },
      'customer_push',
    );

    expect(status.state).toBe('blocked');
    expect(status.missing).toEqual(['NOTIFY_CHANNEL=line']);
  });

  it('is blocked when the channel is right but the token is missing', () => {
    const status = door(
      {
        NOTIFY_CHANNEL: 'line',
        LINE_MESSAGING_CHANNEL_SECRET: 'secret',
      },
      'customer_push',
    );

    expect(status.state).toBe('blocked');
    expect(status.missing).toEqual(['NOTIFY_LINE_TOKEN']);
  });

  it('is blocked without the channel secret, because the friend list would stay empty', () => {
    // The token alone can send. The secret is what lets LINE's webhook record a friend,
    // and the planner refuses a customer who is not one — so this pair is not optional.
    const status = door(
      { NOTIFY_CHANNEL: 'line', NOTIFY_LINE_TOKEN: 'channel-token' },
      'customer_push',
    );

    expect(status.state).toBe('blocked');
    expect(status.missing).toEqual(['LINE_MESSAGING_CHANNEL_SECRET']);
  });

  it('is `off`, not blocked, on a shop that never set any of it up', () => {
    const status = door({}, 'customer_push');

    expect(status.state).toBe('off');
    expect(status.missing).toHaveLength(3);
    // The consequence still has to be stated: silence is the thing being explained.
    expect(status.sentence).toContain('หน้าออเดอร์');
  });

  it('ignores blank values, which is what a `.env` line with nothing after `=` is', () => {
    const status = door(
      {
        NOTIFY_CHANNEL: 'line',
        NOTIFY_LINE_TOKEN: '   ',
        LINE_MESSAGING_CHANNEL_SECRET: '',
      },
      'customer_push',
    );

    expect(status.state).toBe('blocked');
    expect(status.missing).toEqual(['NOTIFY_LINE_TOKEN', 'LINE_MESSAGING_CHANNEL_SECRET']);
  });
});

describe('the other doors', () => {
  it('names the missing half of a half-configured sign-in door', () => {
    const status = door({ LINE_LOGIN_CHANNEL_ID: '1234567890' }, 'sign_in');

    expect(status.state).toBe('blocked');
    expect(status.missing).toEqual(['LINE_LOGIN_CHANNEL_SECRET']);
  });

  it('reports sign-in as off on a shop that uses phone and Google only', () => {
    // Not a fault: the shop works. The sentence says so rather than implying breakage.
    const status = door({}, 'sign_in');

    expect(status.state).toBe('off');
    expect(status.sentence).toContain('Google');
  });

  it('reports the in-app entry as off without a LIFF id, and says the message still sends', () => {
    const status = door({ NOTIFY_CHANNEL: 'line' }, 'liff_entry');

    expect(status.state).toBe('off');
    expect(status.sentence).toContain('ไม่มีลิงก์');
  });

  it('refuses to call campaigns ready when nobody could be recorded as a friend', () => {
    const status = door({ NOTIFY_LINE_TOKEN: 'channel-token' }, 'campaigns');

    expect(status.state).toBe('blocked');
    expect(status.missing).toEqual(['LINE_MESSAGING_CHANNEL_SECRET']);
  });

  it('puts the customer`s door first, because that is the question a shop asks', () => {
    expect(lineReadiness(COMPLETE)[0].id).toBe('customer_push');
  });

  it('reports every door on a fully configured deployment as ready', () => {
    const statuses = lineReadiness(COMPLETE);

    expect(statuses).toHaveLength(5);
    expect(statuses.filter((entry) => entry.state !== 'ready')).toEqual([]);
  });
});

describe('the stalled-outbox decision', () => {
  const now = new Date('2026-10-19T12:00:00+07:00');

  it('says nothing when nothing is due', () => {
    expect(outboxStalled({ dueNow: 0, oldestDueAt: null, now })).toEqual({
      stalled: false,
      waitingMinutes: null,
    });
  });

  it('is not stalled before the grace, however busy the worker looks', () => {
    // A worker passing every 30s must never be reported dead by its own schedule.
    const oldest = new Date(now.getTime() - 9 * 60_000);
    expect(outboxStalled({ dueNow: 3, oldestDueAt: oldest, now }).stalled).toBe(false);
  });

  it('is not stalled at exactly the grace', () => {
    const oldest = new Date(now.getTime() - OUTBOX_STALL_MINUTES * 60_000);
    expect(outboxStalled({ dueNow: 3, oldestDueAt: oldest, now }).stalled).toBe(false);
  });

  it('is stalled one minute past the grace, and says how long', () => {
    const oldest = new Date(now.getTime() - (OUTBOX_STALL_MINUTES + 1) * 60_000);
    const result = outboxStalled({ dueNow: 3, oldestDueAt: oldest, now });

    expect(result.stalled).toBe(true);
    expect(result.waitingMinutes).toBe(OUTBOX_STALL_MINUTES + 1);
  });

  it('treats a due count with no timestamp as stalled rather than fine', () => {
    // Two queries, one answer: if they disagree the queue is not proven to be moving.
    expect(outboxStalled({ dueNow: 1, oldestDueAt: null, now }).stalled).toBe(true);
  });
});
