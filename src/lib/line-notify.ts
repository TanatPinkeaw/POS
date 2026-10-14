/**
 * Who LINE messages are *for*, and what may ride on each (ADR 0030).
 *
 * The outbox's planner (`notify-message.ts`) answers "should the shop tell
 * anybody" from configuration alone; this module answers the question that
 * configuration cannot: **which individual may be told**. Two audiences, two
 * planners, kept apart on purpose because they fail in opposite directions:
 *
 *   * **The customer planner** — may *this* customer be pushed their pickup code?
 *     Every condition is a fact about them: they consented, the subject is bound,
 *     and (at send time) the subject is a friend of the shop's Official Account.
 *     The rule ADR 0007 decision 3 wrote — the collection code never reaches the
 *     shop's own group — is not reopened but *kept*: the code goes only to a
 *     consented, bound, friended customer's own LINE, and to nobody else's room.
 *   * **The shop-fact planner** — does the counter need to hear this? Facts about
 *     orders (a refund, a dismissed transfer) go to the shop's own destination on
 *     either channel. It names no secret, exactly as the pre-order-placed
 *     message never did.
 *
 * Both are pure: no I/O, and the friend row arrives as a parameter the caller
 * read, so the tests pin the *decision* without a database.
 */
import { bangkokTimeString } from './bangkok-time';
import { liffEntryUrl } from './line-liff-entry';
import type { NotificationChannel, PlannedNotification } from './notify-message';

/** Version marker on the consent text; bumped when the wording changes materially. */
export const LINE_CONSENT_VERSION = '2026-10-06';

/**
 * Why a customer's code is not being pushed to their LINE, as the account page
 * states it. Closed set: the page says one sentence per reason and never a
 * number, so a new reason costs a migration of the words, not a re-derivation.
 */
export type LineCustomerNotifyBlock =
  | 'not_bound'
  | 'no_consent'
  | 'not_a_friend'
  | 'channel_not_line';

/** What the customer planner needs, all of it read by the caller. */
export interface LineCustomerNotifyInput {
  channel: NotificationChannel | null;
  /** The shop's own destination; present when the shop configured one. */
  staffTo: string | null;
  customerLineSubject: string | null;
  /** Null means the customer was never asked; a past timestamp means they said yes. */
  consentAt: Date | null;
  /** Read from `line_friends` by the caller at plan time. */
  isFriend: boolean;
}

/** The first reason the customer is not being told on LINE, or null when they are. */
export function lineCustomerNotifyBlock(input: LineCustomerNotifyInput): LineCustomerNotifyBlock | null {
  if (input.channel !== 'line') {
    return 'channel_not_line';
  }
  if (input.customerLineSubject === null) {
    return 'not_bound';
  }
  if (input.consentAt === null) {
    return 'no_consent';
  }
  if (!input.isFriend) {
    return 'not_a_friend';
  }
  return null;
}

/**
 * The message a customer gets on their own LINE when their parcel is ready.
 *
 * Null unless every condition in `lineCustomerNotifyBlock` passes — a blocked
 * message must never become a row for the worker to retry forever, which is the
 * same null the webhook-channel planner returns and for the same reason (an
 * outbox full of undeliverable rows is a to-do list that never shortens).
 *
 * What is *not* null goes only to the customer's own subject. The shop's group is
 * not a fallback for it: if the customer cannot be told on LINE, they are told
 * the way they always were — the code on their order screen — and the outbox
 * stays empty rather than delivering a secret to a room of staff phones.
 */
export function planLineCustomerReadyMessage(
  input: {
    orderId: string;
    orderNumber: string;
    pickupPin: string;
    /** The hold's deadline; stated in Bangkok time, like every other clock here. */
    holdUntil: Date;
  } & LineCustomerNotifyInput,
  /**
   * The environment the LIFF link is read from, injectable for the same reason
   * `readNotifyConfig` takes one: the tests drive both shapes without a `.env`.
   */
  env: Record<string, string | undefined> = process.env,
): { recipient: string; text: string; orderId: string } | null {
  if (lineCustomerNotifyBlock(input) !== null) {
    return null;
  }
  /*
   * The one-tap link into the app the customer is already reading this in (ADR 0032 §2).
   *
   * It is appended only when this deployment has a LIFF app: a shop that has not set one up
   * gets exactly the sentence it sent before, rather than a link to `https://liff.line.me/`
   * that opens LINE with no app in it. Nothing secret rides the link — the collection code is
   * already in the text beside it, and the link only saves the customer from finding the
   * shop again inside LINE.
   */
  const entry = liffEntryUrl(env);
  return {
    recipient: input.customerLineSubject as string,
    text:
      `ออเดอร์ ${input.orderNumber} พร้อมรับแล้ว ` +
      `รหัสรับของ ${input.pickupPin} แสดงที่หน้าออเดอร์ของคุณ ` +
      `ร้านเก็บถึง ${bangkokTimeString(input.holdUntil)} น.` +
      (entry === null ? '' : ` เปิดดูก่อนได้ที่ ${entry}`),
    orderId: input.orderId,
  };
}

/**
 * A fact about the shop's own money, for the shop's own destination.
 *
 * Written in the same transaction as the act it names (ADR 0007 decision 1) and
 * deduped on `(kind, order_id)` — a retried refund is one fact, not two. Null
 * when the shop has configured nothing: unset means nothing is queued, the same
 * rule the whole outbox was opened under.
 */
export function planShopFactMessage(input: {
  channel: NotificationChannel | null;
  staffTo: string | null;
  /** The order's own id, for the `(kind, order_id)` dedupe — a retried refund is one fact. */
  orderId: string;
  orderNumber: string;
  reason: string;
  refundedThb: number;
}): PlannedNotification | null {
  if (input.channel === null || input.staffTo === null) {
    return null;
  }
  return {
    kind: 'order_refunded',
    channel: input.channel,
    recipient: input.staffTo,
    text: `บิล ${input.orderNumber} ถูกคืนเงิน ${input.refundedThb} บาท — เหตุผล: ${input.reason}`,
    orderId: input.orderId,
  };
}

/**
 * How long one burst of messages from one customer stays one fact (ADR 0032 §4).
 *
 * Ten minutes, and it is a *duration*, not a calendar boundary — which is why this does not
 * go through `bangkok-time.ts`: a bucket that shifted with a time zone would make two shops
 * on two clocks disagree about a window that is about how fast a person types. The number is
 * here rather than in the outbox because it is a decision about what the shop wants to hear,
 * not about how a queue works.
 */
export const CUSTOMER_MESSAGE_WINDOW_MINUTES = 10;

/**
 * The key that makes a burst one fact: the customer, and which window they wrote in.
 *
 * Built so the *database* enforces the window: `notifications` has a unique
 * `(kind, dedupe_key)`, so two workers racing on the same burst collide on the index instead
 * of on a read that both of them won. The subject is part of it, so two customers writing in
 * the same window are two facts.
 */
export function customerMessageDedupeKey(subject: string, at: Date): string {
  const windowMs = CUSTOMER_MESSAGE_WINDOW_MINUTES * 60_000;
  return `${subject}:${Math.floor(at.getTime() / windowMs)}`;
}

/** What each kind of message is called on a card, since the shop reads Thai. */
const MESSAGE_KIND_LABEL: Record<string, string> = {
  text: 'ข้อความ',
  image: 'รูปภาพ',
  video: 'วิดีโอ',
  audio: 'ไฟล์เสียง',
  file: 'ไฟล์',
  location: 'ตำแหน่ง',
  sticker: 'สติกเกอร์',
  other: 'ข้อความ',
};

/**
 * One kind of message named in Thai, for the two places that show it.
 *
 * Exported rather than duplicated, because the group fact and the customer's card answer
 * the same question about the same row: a sticker called a sticker in the alert and
 * something else on the card would be two vocabularies for one fact. `other` is the
 * fallback, which is why the set is closed here rather than at each call site.
 */
export function lineMessageKindLabel(kind: string): string {
  return MESSAGE_KIND_LABEL[kind] ?? MESSAGE_KIND_LABEL.other;
}

/** A snippet short enough for one line of a phone notification, in the shop's own words. */
const MESSAGE_SNIPPET_LENGTH = 60;

/**
 * The fact that a customer wrote to the shop, for the shop's own group.
 *
 * **Why the shop hears about a customer at all**, given that LINE's own Official Account app
 * already notifies whoever holds its phone: because those two alerts answer different
 * questions. LINE's says "somebody wrote to the shop"; this one says which customer, and a
 * group is where the counter can see it without one person's phone. It is capped to one per
 * window per customer — see `customerMessageDedupeKey` — because the alert arriving five
 * times for five messages is the version of this a shop mutes.
 *
 * Null when the shop has configured no destination, exactly like every other shop fact: unset
 * means nothing is queued, and an outbox with nowhere to send is a to-do list that never
 * shortens. The message never carries the text of a reply or a code; it carries what the
 * customer said, which the shop's own group is entitled to (ADR 0007 decision 3 keeps its one
 * hard rule: the *collection code* never goes to the group).
 */
export function planCustomerMessageFact(input: {
  channel: NotificationChannel | null;
  staffTo: string | null;
  subject: string;
  /** The customer's name when this deployment holds the LINE account, else null. */
  customerName: string | null;
  kind: string;
  text: string | null;
  /** The clock the window is computed from; injectable so a test can pin a bucket. */
  at: Date;
}): PlannedNotification | null {
  if (input.channel === null || input.staffTo === null) {
    return null;
  }

  const who = input.customerName?.trim() ? input.customerName.trim() : 'ลูกค้า LINE';
  const label = lineMessageKindLabel(input.kind);

  /*
   * A text message quotes what was said, trimmed to one line; anything else says what kind
   * of thing arrived. A snippet rather than the whole body, because this lands on a phone as
   * a notification — the full message is on the customer's card, and the conversation itself
   * is in LINE.
   */
  const detail =
    input.kind === 'text' && input.text !== null && input.text.trim().length > 0
      ? `"${snippetOf(input.text)}"`
      : `ส่ง${label}มา`;

  return {
    kind: 'customer_message',
    channel: input.channel,
    recipient: input.staffTo,
    text: `${who} ส่งข้อความใน LINE ของร้าน — ${detail} ดูที่หน้าลูกค้าในระบบ`,
    orderId: null,
    dedupeKey: customerMessageDedupeKey(input.subject, input.at),
  };
}

/** The first `MESSAGE_SNIPPET_LENGTH` characters, on one line, with a mark when cut. */
function snippetOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MESSAGE_SNIPPET_LENGTH ? flat : `${flat.slice(0, MESSAGE_SNIPPET_LENGTH)}…`;
}

/**
 * The other fact the owner otherwise learns late: a person dismissed an inbound
 * transfer by hand (ADR 0025's audit wording, in the group's own words).
 *
 * Deduped on `(kind, recipient)` because it is a fact about a bank message, not
 * an order — the recipient column is what carries the transfer's own id here,
 * which is the same trick the `inbound_payments` row uses to keep one bank
 * message one row.
 */
export function planShopInboundDismissedMessage(input: {
  channel: NotificationChannel | null;
  staffTo: string | null;
  /** The transfer's own id — what the recipient column carries, and what dedupes. */
  transferId: string;
  amountThb: number | null;
  reason: string;
}): PlannedNotification | null {
  if (input.channel === null || input.staffTo === null) {
    return null;
  }
  const amount = input.amountThb === null ? 'ยอดไม่อ่านได้' : `${input.amountThb} บาท`;
  return {
    kind: 'inbound_dismissed',
    channel: input.channel,
    recipient: input.transferId,
    text: `เงินโอนเข้า ${amount} ถูกปิดไปแล้ว — เหตุผล: ${input.reason}`,
    orderId: null,
  };
}
