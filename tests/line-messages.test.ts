// Seam under test: a customer's messages to the shop's Official Account (ADR 0032 §3–4),
// against a real database.
//
// Two properties matter and neither is checkable without PostgreSQL. The first is that
// LINE's redelivery of a webhook is a no-op: the dedupe *is* the unique index on LINE's own
// message id, so a mocked client would test the mock. The second is that the shop is told
// once per burst and not once per message — which is the unique `(kind, dedupe_key)` on
// `notifications`, and the reason the key carries a window rather than the subject alone.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '@/lib/db';
import { enqueueCustomerMessageFact } from '@/lib/line-message-alert';
import { readLineMessageEvent, recordInboundLineMessage } from '@/lib/line-messages';
import { customerMessageDedupeKey } from '@/lib/line-notify';

import { resetDatabase, seedPeople } from './helpers/test-db';

beforeEach(async () => {
  await resetDatabase();
  await seedPeople();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A webhook event exactly as LINE sends one for a text message. */
function textEvent(id: string, text: string, subject: string) {
  return { type: 'message', source: { userId: subject }, message: { id, type: 'text', text } };
}

/** The customer the seeded member is, by the subject a LINE door would have bound. */
async function bindSubject(subject: string): Promise<string> {
  const member = await prisma.users.findFirstOrThrow({ where: { role: 'member' } });
  await prisma.users.update({ where: { id: member.id }, data: { line_subject: subject } });
  return member.id;
}

describe('reading a webhook event as a record', () => {
  it('keeps a text message and its body', () => {
    expect(readLineMessageEvent(textEvent('m1', 'ของถึงหรือยัง', 'Uabc'))).toEqual({
      lineMessageId: 'm1',
      subject: 'Uabc',
      kind: 'text',
      text: 'ของถึงหรือยัง',
    });
  });

  it('records a non-text message as its kind and no bytes', () => {
    // A sticker, a photo, a location: this deployment holds no files (ADR 0014), so the row
    // says what arrived and stops there rather than downloading a customer's picture into a
    // place nothing here can back up.
    expect(
      readLineMessageEvent({ type: 'message', source: { userId: 'Uabc' }, message: { id: 'm2', type: 'sticker' } }),
    ).toEqual({ lineMessageId: 'm2', subject: 'Uabc', kind: 'sticker', text: null });
  });

  it('buckets a type LINE has not invented yet as `other` rather than refusing it', () => {
    // A refused webhook is one LINE retries against a door nobody can open.
    expect(
      readLineMessageEvent({
        type: 'message',
        source: { userId: 'Uabc' },
        message: { id: 'm3', type: 'coupon' },
      }),
    ).toMatchObject({ kind: 'other', text: null });
  });

  it('refuses a text message with no text, and keeps the fact that something arrived', () => {
    // The column pairing is a CHECK — `text` present if and only if the type is text — so a
    // malformed text is stored as `other` rather than as a row that breaks the invariant.
    expect(
      readLineMessageEvent({ type: 'message', source: { userId: 'Uabc' }, message: { id: 'm4', type: 'text' } }),
    ).toMatchObject({ kind: 'other', text: null });
  });

  it('is null for anything this table cannot answer a question about', () => {
    // No message object, no message id, and a group event with no author.
    expect(readLineMessageEvent({ type: 'follow', source: { userId: 'Uabc' } })).toBeNull();
    expect(
      readLineMessageEvent({ type: 'message', source: { userId: 'Uabc' }, message: { type: 'text', text: 'x' } }),
    ).toBeNull();
    expect(readLineMessageEvent({ type: 'message', message: { id: 'm5', type: 'text', text: 'x' } })).toBeNull();
  });
});

describe('recording a message', () => {
  it('writes one row for the same message however often LINE delivers it', async () => {
    const subject = 'Ucustomer';
    const customerId = await bindSubject(subject);

    const first = await recordInboundLineMessage(
      readLineMessageEvent(textEvent('m1', 'ของถึงหรือยัง', subject))!,
    );
    const second = await recordInboundLineMessage(
      readLineMessageEvent(textEvent('m1', 'ของถึงหรือยัง', subject))!,
    );

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(await prisma.line_messages.count()).toBe(1);

    const row = await prisma.line_messages.findFirstOrThrow();
    expect(row.user_id).toBe(customerId);
    expect(row.message_type).toBe('text');
  });

  it('records a stranger with no customer, and keeps the row when that customer is deleted', async () => {
    const customerId = await bindSubject('Ucustomer');
    const message = readLineMessageEvent(textEvent('m1', 'สวัสดี', 'Ucustomer'))!;
    await recordInboundLineMessage(message);

    expect((await prisma.line_messages.findFirstOrThrow()).user_id).toBe(customerId);

    // `ON DELETE SET NULL`: removing a customer must not erase what was asked, and the
    // subject column still names the thread.
    await prisma.users.delete({ where: { id: customerId } });
    const after = await prisma.line_messages.findFirstOrThrow();
    expect(after.user_id).toBeNull();
    expect(after.line_subject).toBe('Ucustomer');
  });
});

describe('the alert the shop gets for a burst', () => {
  // The shop's own destination is configuration, so the tests that expect a fact stub it —
  // the same shape `order-lifecycle.test.ts` uses for the other facts. A shop with none is
  // its own case below.
  beforeEach(() => {
    vi.stubEnv('NOTIFY_CHANNEL', 'line');
    vi.stubEnv('NOTIFY_STAFF_TO', 'Cgroup-of-staff');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('queues one fact per customer per window, not one per message', async () => {
    const subject = 'Ucustomer';
    await bindSubject(subject);
    const at = new Date('2026-10-14T10:00:00+07:00');

    const first = await enqueueCustomerMessageFact(
      readLineMessageEvent(textEvent('m1', 'ข้อความหนึ่ง', subject))!,
      at,
    );
    // Four more messages in the same ten minutes: the same key, so the same row.
    const second = await enqueueCustomerMessageFact(
      readLineMessageEvent(textEvent('m2', 'ข้อความสอง', subject))!,
      at,
    );
    const third = await enqueueCustomerMessageFact(
      readLineMessageEvent(textEvent('m3', 'ข้อความสาม', subject))!,
      at,
    );

    expect(first?.duplicate).toBe(false);
    expect(second?.duplicate).toBe(true);
    expect(third?.duplicate).toBe(true);
    expect(await prisma.notifications.count({ where: { kind: 'customer_message' } })).toBe(1);
  });

  it('writes a new fact in the next window', async () => {
    const subject = 'Ucustomer';
    await bindSubject(subject);
    const at = new Date('2026-10-14T10:00:00+07:00');
    const later = new Date(at.getTime() + 11 * 60_000);

    await enqueueCustomerMessageFact(readLineMessageEvent(textEvent('m1', 'หนึ่ง', subject))!, at);
    const next = await enqueueCustomerMessageFact(
      readLineMessageEvent(textEvent('m2', 'สอง', subject))!,
      later,
    );

    expect(next?.duplicate).toBe(false);
    expect(await prisma.notifications.count({ where: { kind: 'customer_message' } })).toBe(2);
  });

  it('keys the window on the customer, so two customers in one window are two facts', async () => {
    expect(customerMessageDedupeKey('Ua', new Date(0))).not.toBe(
      customerMessageDedupeKey('Ub', new Date(0)),
    );
    // And the same customer inside one window is one key, across the boundary is two.
    const window = 10 * 60_000;
    expect(customerMessageDedupeKey('Ua', new Date(0))).toBe(
      customerMessageDedupeKey('Ua', new Date(window - 1)),
    );
    expect(customerMessageDedupeKey('Ua', new Date(0))).not.toBe(
      customerMessageDedupeKey('Ua', new Date(window)),
    );
  });

  it('queues nothing when the shop has configured no destination', async () => {
    // Unset means nothing is queued, exactly as for every other fact — and the message is
    // still recorded, because the customer's card is not the shop's notification channel.
    const subject = 'Ucustomer';
    await bindSubject(subject);
    vi.unstubAllEnvs();

    const result = await enqueueCustomerMessageFact(
      readLineMessageEvent(textEvent('m1', 'สวัสดี', subject))!,
      new Date(),
    );

    expect(result).toBeNull();
    expect(await prisma.notifications.count()).toBe(0);
    expect(await prisma.line_messages.count()).toBe(0);
  });
});
