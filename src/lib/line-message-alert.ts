/**
 * Telling the shop a customer wrote (ADR 0032 §4).
 *
 * The webhook records the message first and calls this only when the row was *new*, so a
 * redelivery from LINE cannot alert the shop twice about one message. What is left here is
 * the small amount of reading the pure planner cannot do: whether the shop has a
 * destination at all, and what the customer is called.
 *
 * One fact per customer per window, and the window is the planner's (`line-notify.ts`) —
 * enforced by the outbox's unique `(kind, dedupe_key)` rather than by a read, because two
 * webhook deliveries can arrive at the same moment. That index is why this function is safe
 * to call for every message: five messages in a burst produce five calls, one row, and the
 * other four report `duplicate`.
 *
 * It never throws for a shop that has configured nothing. `enqueueNotification` of a null
 * plan is null and stops there, which is the same "unset means nothing is queued" rule every
 * other fact follows — a shop that has not set up notifications still keeps the messages on
 * the customer's card.
 */
import { prisma } from './db';
import { planCustomerMessageFact } from './line-notify';
import type { InboundLineMessage } from './line-messages';
import { readNotifyConfig } from './notify-message';
import { enqueueNotification, type EnqueueResult } from './notify-outbox';

/**
 * Queues the shop's fact about one inbound message, if the shop has anywhere to hear it.
 *
 * `at` is the clock the burst window is computed from and is injectable for the tests — the
 * same reason `enqueueNotification` takes a transaction handle and `outboxHealth` takes a
 * date: a function whose behaviour depends on the time must be drivable from a test that
 * does not depend on it.
 */
export async function enqueueCustomerMessageFact(
  message: InboundLineMessage,
  at: Date = new Date(),
): Promise<EnqueueResult | null> {
  const config = readNotifyConfig();
  if (config.channel === null || config.staffTo === null) {
    return null;
  }

  /*
   * The name is read here rather than passed in, because only this layer knows the subject
   * may resolve to a customer: a stranger writing to the shop has no row, and the fact says
   * so in words rather than in a null.
   */
  const customer = await prisma.users.findUnique({
    where: { line_subject: message.subject },
    select: { full_name: true },
  });

  const plan = planCustomerMessageFact({
    channel: config.channel,
    staffTo: config.staffTo,
    subject: message.subject,
    customerName: customer?.full_name ?? null,
    kind: message.kind,
    text: message.text,
    at,
  });

  return enqueueNotification(prisma, plan);
}
