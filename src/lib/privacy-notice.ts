/**
 * The customer privacy notice's identity — one place, so the page and the server agree.
 *
 * **Why a version exists at all.** A shop is required to tell its customers what it does
 * with their data, and a customer who signs up online is told at the moment they sign up
 * (`CustomerSignIn`). Recording *that* they were told is only worth anything if the
 * record says **which** text they were told: the notice will be edited — its retention
 * periods change when the shop changes its configuration, and its effective date is a
 * literal precisely because it must move in the same commit as the change — and a bare
 * timestamp would leave the shop unable to say what a customer agreed to on the day.
 *
 * So the version is the effective date. One value, not two, because two values drift:
 * a version bumped without a new date (or the reverse) produces acknowledgements that
 * look current and are not.
 *
 * **Why it is ISO and not the Thai string.** The notice prints "3 ตุลาคม 2569" to a
 * person; the database stores `2026-10-03`. Ordering and comparison are the two things a
 * stored value is for, and a Buddhist-era string does neither. `noticeEffectiveDateLabel`
 * is the only place the two meet.
 *
 * **Why the server checks it rather than the page.** A checkbox the browser enforces is
 * a courtesy, not a control — the request that creates the customer is an HTTP POST that
 * anybody can send without ever loading the page. So the signup route refuses an
 * acknowledgement naming a version that is not the current one, which means a stored
 * acknowledgement always corresponds to text that was on the notice at the time.
 */
import type { Db } from './inventory';

/** The day this version of the customer notice took effect, as stored. */
/**
 * Bumped to 2026-10-04 when the notice began naming the consignment offer form
 * (ADR 0025): the shop now collects a product name, an asked-for price, a count and
 * photo links from a member on its own account page, which is a new collection point
 * and so something the Act asks a controller to state.
 *
 * It is worth noting what this date does *not* now claim. An earlier draft of ADR 0025
 * sent those answers through a Google Form, which would have added Google as a third
 * party and made the cross-border question under PDPA §28 live. The form is gone, so the
 * notice no longer names Google for this purpose, and the only remaining Google
 * disclosure is the sign-in door in ADR 0020 — which was always there.
 *
 * Changing the text without moving this date would leave every earlier acknowledgement
 * pointing at words the member never read, which is the one thing an acknowledgement
 * exists to prevent.
 */
export const CUSTOMER_NOTICE_EFFECTIVE_FROM = '2026-10-04';

/**
 * The version a signup must acknowledge.
 *
 * Read from the effective date rather than declared beside it, so the two cannot
 * disagree — and `privacy-notice.test.ts` asserts a signup naming anything else is
 * refused, which is what turns "they were shown the notice" into a fact.
 */
export const CURRENT_CUSTOMER_NOTICE_VERSION = CUSTOMER_NOTICE_EFFECTIVE_FROM;

/** Whether `version` is the notice the shop is currently showing. */
export function isCurrentCustomerNotice(version: string | undefined): boolean {
  return version === CURRENT_CUSTOMER_NOTICE_VERSION;
}

/** Where the customer notice lives, and the path recorded against an acknowledgement. */
export const CUSTOMER_NOTICE_PATH = '/privacy';

/**
 * Record that a customer was shown the notice.
 *
 * **Written in the same transaction as the customer.** The two facts are one fact: a
 * shop that can say "this customer was told" must not be able to produce a customer who
 * was not, and an acknowledgement written after `users.create` returns leaves a window
 * where a crash in between leaves an account with no record of the notice — the one
 * outcome the row exists to rule out. So `identity.ts` passes its transaction in rather
 * than calling this afterwards.
 *
 * **The version is written as given, after the caller checked it.** Re-deriving it here
 * would be tidier and wrong: it would store the *current* version onto an acknowledgement
 * the customer actually gave for an older one, which is the specific lie this table must
 * not be able to tell. The check belongs where the version arrives
 * (`isCurrentCustomerNotice`), and this function's job is to record faithfully.
 */
export async function recordNoticeAcknowledgement(
  db: Db,
  input: { customerUserId: string; noticeVersion: string; noticeUrl?: string },
): Promise<void> {
  await db.notice_acknowledgements.create({
    data: {
      customer_user_id: input.customerUserId,
      notice_version: input.noticeVersion,
      notice_url: input.noticeUrl ?? CUSTOMER_NOTICE_PATH,
    },
  });
}

/**
 * The newest version this customer was shown, or null if they never were.
 *
 * Read by the shop's own screen rather than by the customer, so it answers "may I show
 * this again" rather than "may I sell you a coffee" — an account without a current
 * acknowledgement is still an account, because the notice is the shop's duty to inform
 * and not a condition of the sale (`pos_walkin` exists precisely so it is not one).
 */
export async function latestNoticeVersionFor(
  db: Db,
  customerUserId: string,
): Promise<string | null> {
  const row = await db.notice_acknowledgements.findFirst({
    where: { customer_user_id: customerUserId },
    select: { notice_version: true },
    orderBy: { acknowledged_at: 'desc' },
  });
  return row?.notice_version ?? null;
}

/**
 * How far from the bottom still counts as having reached it, in pixels.
 *
 * `24` rather than `0`, because a finger dragging a scroll container on a phone rarely
 * lands on the last pixel — and a gate that refuses to open one pixel short of the end
 * is a gate the reader cannot work out how to pass, which is worse than the formality it
 * replaces. Big enough to forgive a drag, far smaller than the paragraph it sits inside,
 * so it cannot open before the last one is visible.
 */
export const NOTICE_SCROLL_TOLERANCE_PX = 24;

/**
 * Whether a scroll box has been read to its end.
 *
 * **A pure function of three measurements**, for the reason `receipt-access.ts` gives:
 * it is the only way to test the boundary without a browser, and this boundary is the
 * one number in the signup that decides whether a customer can tick a box.
 *
 * **Three numbers rather than a `ScrollEvent`,** because the interesting cases are the
 * ones a real scroll never produces — a box with nothing to scroll, and a box scrolled
 * past its own end by a rubber-band bounce. Both are reachable by a phone and neither is
 * reachable by a test that only dispatches scrolls.
 *
 * **Nothing short of the end counts, in either direction.** Scrolling back up does not
 * re-lock a box already read: a customer who reaches the end, scrolls back to re-read a
 * paragraph and arrives at the bottom again has not un-read anything. This function is
 * therefore monotone in "have they read it", and the component keeps that once-true
 * fact in state.
 */
export function hasReachedNoticeEnd(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  // A box shorter than its content has an end; one that fits has none, and a customer
  // who can see all of it has read all of it. Without this the gate would be
  // unreachable on a notice that happens to be short.
  if (scrollHeight <= clientHeight) {
    return true;
  }
  return scrollTop + clientHeight >= scrollHeight - NOTICE_SCROLL_TOLERANCE_PX;
}

const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
] as const;

/**
 * `2026-10-03` as a person reads a date in this system: `3 ตุลาคม 2569`.
 *
 * Buddhist era throughout, because a Thai shop's tax and payroll documents are in BE and
 * a notice in CE beside them would be the odd one out. The year is stored as CE and
 * converted here rather than stored as 2569, so the stored value still sorts.
 *
 * Parsed by hand rather than by `new Date`, so the answer does not move with the
 * machine's timezone: a notice that read "2 ตุลาคม" on a server west of Bangkok would
 * be a different notice on a different day, which is the one thing a legal document must
 * not be.
 *
 * **A year in the future is refused rather than printed.** `2569-10-03` is a
 * perfectly well-formed ISO date — it is a Buddhist-era year written where a
 * Gregorian one belongs, which is the single most likely mistake somebody editing this
 * constant makes, since every date a Thai person writes down is in BE. Converting it
 * would print "3 ตุลาคม 3112": not an error, not blank, just a date five centuries out
 * that reads like a real one. An effective date cannot be in the future, so this states
 * that rather than leaving a plausible-looking wrong answer on a legal document.
 */
export function noticeEffectiveDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) {
    // A malformed constant is a programming error, not a customer-facing state; saying
    // so plainly beats printing a date nobody can read.
    throw new Error(`not an ISO date: ${iso}`);
  }
  const [, year, month, day] = match;
  const monthIndex = Number(month) - 1;
  const monthName = THAI_MONTHS[monthIndex];
  if (monthName === undefined) {
    throw new Error(`month out of range: ${iso}`);
  }
  const gregorianYear = Number(year);
  if (gregorianYear > new Date().getUTCFullYear()) {
    throw new Error(
      `effective date is in the future, or a Buddhist-era year in a Gregorian field: ${iso}`,
    );
  }
  return `${Number(day)} ${monthName} ${gregorianYear + 543}`;
}