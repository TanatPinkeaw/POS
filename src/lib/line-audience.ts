/**
 * How many customers the shop can actually tell about their own order (ADR 0035).
 *
 * `/admin/line` already answers "who would a *promotion* reach" (`readCampaignAudience`),
 * and that is a different question with a different consent: a promotion needs
 * `line_promo_consent_at`, while the "order ready" message needs the notification consent
 * that placing the order asked for (`line_consent_at`). Reusing the campaign audience
 * here would under-count by exactly the customers who said yes to their own order and no
 * to marketing — which is most of them — and make the readiness panel look worse than
 * the shop is.
 *
 * Its own module rather than a read inside `line-notify.ts`, because that file is pure
 * and says so: both planners there are decisions, and a decision that opens a database
 * connection is a decision no unit test can make. `line-campaigns.ts` is the mirror
 * image — persistence for the promotion half — so this is persistence for the
 * notification half, three counts and one rule.
 */
import { prisma } from './db';
import type { Db } from './inventory';
import { friendSubjects } from './line-friends';

export interface NoticeAudience {
  /** Customers with a LINE account bound to this shop at all. */
  bound: number;
  /** Of those, the ones who agreed to be told about their own order. */
  consented: number;
  /**
   * Of those, the ones LINE will deliver to — a push to a customer who has not added the
   * Official Account is refused with a 200, the refusal that looks like success.
   */
  reachable: number;
}

/**
 * The three numbers in one pass.
 *
 * Two queries rather than one per customer, the same shape `readCampaignAudience` uses:
 * candidates with their consent, then a set of friend subjects. A shop with no LINE
 * customers pays two cheap queries and gets three zeros, which is the honest answer.
 *
 * Members only. A staff or admin row may legitimately hold a `line_subject` (a supervisor
 * who bound their own LINE), and counting them would promise a message to somebody who
 * will never place an order.
 */
export async function readNoticeAudience(db: Db = prisma): Promise<NoticeAudience> {
  const rows = await db.users.findMany({
    where: { role: 'member', line_subject: { not: null } },
    select: { line_subject: true, line_consent_at: true },
  });

  const subjects = rows.map((row) => row.line_subject as string);
  const friends = await friendSubjects(subjects, db);

  const consented = rows.filter((row) => row.line_consent_at !== null);
  const reachable = consented.filter((row) => friends.has(row.line_subject as string));

  return {
    bound: rows.length,
    consented: consented.length,
    reachable: reachable.length,
  };
}
