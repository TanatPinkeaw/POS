/**
 * The shop's half of the consent pair: who has added the Official Account (ADR 0030 §2).
 *
 * A LINE push is only delivered to a *friend* of the Official Account — an unfollowed user's
 * push is refused with a 200, which is the worst kind of refusal because it looks like
 * success — so the customer planner checks this beside the consent, and the campaign audience
 * does too. The table is keyed by subject and deliberately standalone (no foreign key), so the
 * webhook can write it before any customer has bound that LINE account: a customer who adds
 * the shop today and binds tomorrow is a friend waiting for its row to mean something.
 *
 * One module owns the table, the same way `line-messages.ts` owns the message log and
 * `inbound-payments.ts` owns the bank's rows. The webhook used to write these two statements
 * inline, which was fine when nothing read them; now that three callers ask "is this one a
 * friend", the question and its writes belong in one place.
 */
import { prisma } from './db';
import type { Db } from './inventory';

/** Records that this LINE account added the shop. Idempotent: a repeated `follow` is one row. */
export async function markLineFriend(subject: string, db: Db = prisma): Promise<void> {
  await db.line_friends.upsert({
    where: { line_subject: subject },
    create: { line_subject: subject },
    // A `follow` that arrives twice (LINE retries a webhook it could not deliver) must not
    // rewrite `followed_at`: when the friendship began is a fact with one answer.
    update: {},
  });
}

/**
 * Records that this LINE account removed the shop.
 *
 * A delete rather than a flag, because the row's own existence *is* the condition and a
 * `followed_at` with a `removed_at` beside it would make every reader compare two columns
 * (the mistake the promotion consent's two timestamps are deliberately allowed to make, and
 * which this one does not need: there is no reading of "was a friend, is not now" that the
 * absence of a row cannot carry).
 */
export async function clearLineFriend(subject: string, db: Db = prisma): Promise<void> {
  await db.line_friends.deleteMany({ where: { line_subject: subject } });
}

/**
 * Which of these subjects are still friends, as one query.
 *
 * A set rather than a boolean per candidate: the callers ask about a whole customer list at
 * once (the campaign audience) or a single subject (the ready message), and neither should
 * pay a query per row.
 */
export async function friendSubjects(
  subjects: readonly string[],
  db: Db = prisma,
): Promise<Set<string>> {
  if (subjects.length === 0) {
    return new Set();
  }
  const rows = await db.line_friends.findMany({
    where: { line_subject: { in: [...subjects] } },
    select: { line_subject: true },
  });
  return new Set(rows.map((row) => row.line_subject));
}

/** Whether one subject is a friend, for the single-customer callers. */
export async function isLineFriend(subject: string, db: Db = prisma): Promise<boolean> {
  const row = await db.line_friends.findUnique({
    where: { line_subject: subject },
    select: { line_subject: true },
  });
  return row !== null;
}

/** How many friends the shop has, which is the denominator of any "reached" number. */
export async function countLineFriends(db: Db = prisma): Promise<number> {
  return db.line_friends.count();
}
