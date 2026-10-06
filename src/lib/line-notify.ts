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
): { recipient: string; text: string; orderId: string } | null {
  if (lineCustomerNotifyBlock(input) !== null) {
    return null;
  }
  return {
    recipient: input.customerLineSubject as string,
    text:
      `ออเดอร์ ${input.orderNumber} พร้อมรับแล้ว ` +
      `รหัสรับของ ${input.pickupPin} แสดงที่หน้าออเดอร์ของคุณ ` +
      `ร้านเก็บถึง ${bangkokTimeString(input.holdUntil)} น.`,
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
