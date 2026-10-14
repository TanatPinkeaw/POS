/**
 * A customer's messages to the shop's Official Account (ADR 0032 §3).
 *
 * The webhook has received `message` events since ADR 0030 and recorded nothing, so the one
 * channel the shop's customers actually use carried no history this system could read. This
 * module owns the table that fixes that: what arrives becomes one row, tied to the customer
 * row it came from when one exists.
 *
 * Two halves, split the way the repository splits every rule from its persistence:
 *
 *   * `readLineMessageEvent` is **pure** — a webhook event in, a normalised record or null
 *     out — so the tricky parts (which types exist, what a future LINE type does, a text
 *     message with no text) are testable without a server.
 *   * `recordInboundLineMessage` writes it, and is the only writer. The dedupe is the
 *     database's: `createMany` with `skipDuplicates` on the unique `line_message_id`, which
 *     answers in the same statement whether this event had been seen before. LINE redelivers
 *     a webhook it did not get a 2xx for, and a redelivery must be a no-op rather than a
 *     second row — the same rule `inbound_payments` applies to the bank's `Message-ID`.
 *
 * **Why the id matters to the caller.** The return value says whether this was new. That is
 * what stops the shop being told about the same message twice: the alert (ticket 04) is
 * enqueued only for a row this call actually created.
 */
import { prisma } from './db';

/**
 * The message kinds this deployment records.
 *
 * Deliberately a closed set with an `other` door rather than "whatever LINE sends": the
 * column is what a card reads and what a count groups by, and a value nobody has ever
 * reasoned about should not appear in either. The database enforces the same list with a
 * CHECK, so a bug here cannot write a ninth kind.
 */
export const LINE_MESSAGE_KINDS = [
  'text',
  'image',
  'video',
  'audio',
  'file',
  'location',
  'sticker',
  'other',
] as const;

export type LineMessageKind = (typeof LINE_MESSAGE_KINDS)[number];

/** One inbound message, normalised — the shape the table takes. */
export interface InboundLineMessage {
  /** LINE's own message id: what makes a redelivery a no-op. */
  lineMessageId: string;
  /** The LINE user id that wrote it (the same value as a `line_subject`). */
  subject: string;
  kind: LineMessageKind;
  /** Present if and only if `kind` is `text` — the pairing the CHECK enforces. */
  text: string | null;
}

/** The slice of a webhook event this reads; the route's own type is wider. */
export interface LineMessageEventLike {
  type?: string;
  source?: { userId?: string };
  message?: { id?: string; type?: string; text?: string };
}

/**
 * One webhook event as a record, or null when it is not a message worth storing.
 *
 * Null covers three different non-messages, and none of them is an error: an event with no
 * `message` object, one with no message id to dedupe on, and one from a chat with no user
 * (a group or a room — `source.userId` is absent there, and a message with no author is not
 * something this table can answer a question about).
 *
 * **A future LINE type is `other`, not a refusal.** LINE adds message types, and a webhook
 * this system refuses is one LINE retries against a door nobody can open. Likewise a text
 * message that arrived without its `text`: the pairing CHECK is a fact about the column, so
 * the honest record of a malformed text is `other` with no body rather than a row that
 * breaks the invariant or a throw that fails the whole delivery.
 */
export function readLineMessageEvent(event: LineMessageEventLike): InboundLineMessage | null {
  if (event.type !== 'message') {
    return null;
  }

  const lineMessageId = event.message?.id?.trim();
  const subject = event.source?.userId?.trim();
  if (!lineMessageId || !subject) {
    return null;
  }

  const kind = normaliseMessageKind(event.message?.type);
  const text = kind === 'text' ? event.message?.text : undefined;

  if (kind === 'text' && typeof text !== 'string') {
    return { lineMessageId, subject, kind: 'other', text: null };
  }

  return {
    lineMessageId,
    subject,
    kind,
    text: kind === 'text' ? (text as string) : null,
  };
}

/** LINE's type string as one of ours, with anything unrecognised landing on `other`. */
function normaliseMessageKind(type: string | undefined): LineMessageKind {
  const candidate = (type ?? '').trim().toLowerCase();
  return (LINE_MESSAGE_KINDS as readonly string[]).includes(candidate)
    ? (candidate as LineMessageKind)
    : 'other';
}

/**
 * Records one inbound message, and says whether it was new.
 *
 * `skipDuplicates` is the dedupe, and it is deliberately the database's rather than a
 * read-then-write: two webhook deliveries can arrive at once, and a read between them would
 * let both through. The count Prisma returns is exactly "did this row already exist".
 *
 * The customer is resolved from the subject — one query, because LINE says a LINE Login
 * `sub` and a Messaging API `userId` are the same value for the same person when both
 * channels sit under one provider. A subject nobody here holds is stored with a null
 * `user_id` rather than dropped: a stranger writing to the shop is a fact the shop may need.
 */
export async function recordInboundLineMessage(
  message: InboundLineMessage,
): Promise<{ recorded: boolean }> {
  const customer = await prisma.users.findUnique({
    where: { line_subject: message.subject },
    select: { id: true },
  });

  const result = await prisma.line_messages.createMany({
    data: [
      {
        line_message_id: message.lineMessageId,
        line_subject: message.subject,
        user_id: customer?.id ?? null,
        message_type: message.kind,
        text: message.text,
      },
    ],
    skipDuplicates: true,
  });

  return { recorded: result.count === 1 };
}

/** One message as a customer's card reads it. */
export interface CustomerMessageRow {
  id: string;
  kind: string;
  text: string | null;
  receivedAt: Date;
}

/**
 * The newest messages one customer sent, for the card on `/admin/members`.
 *
 * Newest first, and a short list: this is the context beside a customer's points and orders,
 * not a chat client (ADR 0032 §8). The message log as a whole belongs to LINE's own Official
 * Account app, which is where staff answer.
 */
export async function recentMessagesForUser(
  userId: string,
  limit = 5,
): Promise<CustomerMessageRow[]> {
  const rows = await prisma.line_messages.findMany({
    where: { user_id: userId },
    orderBy: { received_at: 'desc' },
    take: limit,
    select: { id: true, message_type: true, text: true, received_at: true },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.message_type,
    text: row.text,
    receivedAt: row.received_at,
  }));
}

/**
 * How many messages each of the given customers has sent, in one query.
 *
 * A list screen cannot ask per row: the customer list is rendered on the server and a query
 * per member would be a query per member. Only the counts are returned, because that is all
 * the row shows — the messages themselves are one click away on the card.
 */
export async function messageCountsForUsers(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.line_messages.groupBy({
    by: ['user_id'],
    where: { user_id: { in: userIds } },
    _count: { _all: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.user_id !== null) {
      counts.set(row.user_id, row._count._all);
    }
  }
  return counts;
}
