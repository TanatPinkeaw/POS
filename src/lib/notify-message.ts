/**
 * What the shop tells people, and out of which channel.
 *
 * A *planner*, not a sender. It answers three questions with no I/O at all —
 * should there be a message, who is it for, what does it say — and returns `null`
 * when the answer is "none". That null is the important part: a message that
 * cannot be delivered must never become a row for a worker to retry forever, and
 * an outbox full of undeliverable rows is a to-do list that never shortens.
 *
 * The other reason this is pure: the rule that a customer's collection code must
 * never be pushed to the shop's own group is a *decision about wording and
 * audience*, and it is tested without a network, a database or a mailbox.
 */
import { bangkokTimeString } from './bangkok-time';

/**
 * The channels a shop can configure.
 *
 * Both are `fetch` calls to a URL the shop already has, because this system
 * deliberately owns no SMS account and no payment provider: the same reason the
 * bank bridge reads the shop's own mailbox.
 */
export type NotificationChannel = 'line' | 'webhook';

/*
 * Everything the outbox carries. The two customer kinds are planned here; the two
 * shop-fact kinds (ADR 0030 §3) are planned by `line-notify.ts` because they answer
 * a different question — what the *counter* needs to hear rather than what a
 * *customer* is told. One union, so the table's vocabulary cannot drift from the
 * planners' own.
 */
export type NotificationKind =
  | 'pre_order_placed'
  | 'order_ready'
  | 'order_refunded'
  | 'inbound_dismissed';

export interface NotifyConfig {
  /** Null when the shop has not configured delivery; nothing is planned then. */
  channel: NotificationChannel | null;
  /**
   * Where the shop's *own* notifications go: a LINE group id, or a phone number
   * if the channel is an SMS gateway.
   *
   * Deliberately one destination for the shop and not a list of staff numbers: a
   * group is a group, and keeping a roster of personal phones in step with the
   * staff table is a job nobody asked for.
   */
  staffTo: string | null;
}

export interface PlannedNotification {
  kind: NotificationKind;
  channel: NotificationChannel;
  recipient: string;
  text: string;
  /**
   * The order this is about — null for a fact about something that is not an
   * order (an inbound transfer dismissed by hand, ADR 0030 §3). A null-order
   * message dedupes on `(kind, recipient)` instead, which is the column that
   * names the thing it is about when no order does.
   */
  orderId: string | null;
}

/** SMS is billed per 70 Thai characters; this is a tripwire, not a target. */
export const MAX_TEXT_LENGTH = 200;

/** Reads the shop's delivery configuration, treating anything unknown as off. */
/**
 * A plain `Record` rather than `NodeJS.ProcessEnv`: the tests pass literal maps,
 * and `ProcessEnv` demands a `NODE_ENV` that a partial map has no business
 * inventing just to be read from.
 */
export function readNotifyConfig(env: Record<string, string | undefined> = process.env): NotifyConfig {
  const raw = env.NOTIFY_CHANNEL?.trim().toLowerCase();
  const channel: NotificationChannel | null =
    raw === 'line' || raw === 'webhook' ? raw : null;
  const staffTo = env.NOTIFY_STAFF_TO?.trim();

  return { channel, staffTo: staffTo ? staffTo : null };
}

/** Whether delivery is configured at all — the one gate on enqueueing anything. */
export function notifyEnabled(config: NotifyConfig = readNotifyConfig()): boolean {
  return config.channel !== null;
}

/**
 * The message a customer gets when their parcel is on the shelf.
 *
 * Null on a LINE channel, and that is the decision this file is named for. A LINE
 * push addresses a LINE user id; the only one this shop has is its own staff
 * group, and a phone number is not one. Sending the code there would put every
 * waiting parcel's PIN into a room full of staff phones — while the customer, who
 * is the only person entitled to it, already has it on their own order screen.
 *
 * What a shop on LINE gets instead is the in-app and on-screen path it has today,
 * plus the staff notification below.
 */
export function planOrderReadyNotification(
  input: {
    orderId: string;
    orderNumber: string;
    pickupPin: string;
    /** The hold's deadline; stated in Bangkok time, like every other clock here. */
    holdUntil: Date;
    customerPhone: string | null;
  },
  config: NotifyConfig = readNotifyConfig(),
): PlannedNotification | null {
  const phone = input.customerPhone?.trim();
  if (config.channel !== 'webhook' || !phone) {
    return null;
  }

  return {
    kind: 'order_ready',
    channel: config.channel,
    recipient: phone,
    orderId: input.orderId,
    text:
      `ออเดอร์ ${input.orderNumber} พร้อมรับแล้ว ` +
      `แจ้ง PIN ${input.pickupPin} ที่เคาน์เตอร์ ` +
      `เก็บถึง ${bangkokTimeString(input.holdUntil)} น.`,
  };
}

/**
 * The message the shop gets when somebody orders.
 *
 * This is the half of the pre-order feature that was missing: the board chimes,
 * but a shop whose counter is away from the screen hears nothing. It goes to the
 * shop's own destination on either channel, because it names no secret.
 */
export function planPreOrderPlacedNotification(
  input: {
    orderId: string;
    orderNumber: string;
    customerName: string | null;
    itemCount: number;
    totalThb: number;
  },
  config: NotifyConfig = readNotifyConfig(),
): PlannedNotification | null {
  if (config.channel === null || config.staffTo === null) {
    return null;
  }

  /*
   * The blank name is dropped rather than interpolated as an empty string, so the
   * message reads as one sentence instead of a double space — and a name that is
   * absent never arrives as the word "null" in a customer's or a manager's phone.
   */
  const who = input.customerName?.trim() ? ` ${input.customerName.trim()}` : '';

  return {
    kind: 'pre_order_placed',
    channel: config.channel,
    recipient: config.staffTo,
    orderId: input.orderId,
    text:
      `พรีออเดอร์ใหม่ ${input.orderNumber}${who} ` +
      `${input.itemCount} รายการ รวม ${input.totalThb} บาท`,
  };
}

/*
 * The two planners above keep their `orderId: string` in the type they return —
 * widening it to `string | null` here would push a null check into every reader
 * of a pre-order message for a case none of them can meet. The shop-fact planners
 * in `line-notify.ts` return the widened shape directly, and `enqueueNotification`
 * accepts both.
 */
