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

/**
 * Version marker on the consent text; bumped when the wording changes materially.
 *
 * `2026-10-19` — the card now names the five facts this consent covers (accepted, ready,
 * cancelled, a reminder before the hold ends, and the receipt link), rather than promising
 * only the ready message. Recorded per row, never compared: the gate reads
 * `line_consent_at`, so bumping this does not re-ask anyone and does not cut off a customer
 * who agreed to the previous wording (ADR 0035 §6).
 */
export const LINE_CONSENT_VERSION = '2026-10-19';

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

/** What a customer-facing planner returns: who, what, and which order it names. */
export interface CustomerLinePlan {
  recipient: string;
  text: string;
  orderId: string;
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
): CustomerLinePlan | null {
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
 * The one-tap link, appended rather than woven in, so the four sentences stay readable.
 *
 * Null when this deployment has no LIFF app — a message that ends in a link to
 * `https://liff.line.me/` with nothing after it is worse than a message without a link.
 */
function withEntry(text: string, env: Record<string, string | undefined>): string {
  const entry = liffEntryUrl(env);
  return entry === null ? text : `${text} เปิดดูก่อนได้ที่ ${entry}`;
}

/**
 * The order was accepted, and the customer is told — possibly with lines dropped.
 *
 * The partial-confirmation case is why the count and the total are in the sentence: a
 * customer who ordered three things and hears "ยืนยันแล้ว" about two needs the correction
 * in the same breath, not on a screen they may not open before arriving.
 *
 * Null on every condition `lineCustomerNotifyBlock` names, exactly like the ready
 * planner: an unreachable message must not become an outbox row retried forever.
 */
export function planLineCustomerConfirmedMessage(
  input: {
    orderId: string;
    orderNumber: string;
    itemCount: number;
    finalAmountThb: number;
    /** Lines staff dropped because they could not fulfil them. Zero is the usual case. */
    removedCount: number;
  } & LineCustomerNotifyInput,
  env: Record<string, string | undefined> = process.env,
): CustomerLinePlan | null {
  if (lineCustomerNotifyBlock(input) !== null) {
    return null;
  }

  const removed =
    input.removedCount > 0 ? ` (ตัดออก ${input.removedCount} รายการที่ร้านไม่มี)` : '';

  return {
    recipient: input.customerLineSubject as string,
    text: withEntry(
      `ออเดอร์ ${input.orderNumber} ยืนยันแล้ว — ${input.itemCount} รายการ ` +
        `รวม ${input.finalAmountThb} บาท${removed}`,
      env,
    ),
    orderId: input.orderId,
  };
}

/**
 * The order was cancelled by the shop, and the customer hears it from the shop.
 *
 * **Only a staff cancellation.** A customer who withdrew their own pre-order is the actor,
 * not the audience, and sending them a note about the thing they just did is noise —
 * `cancelOrder` decides that (`staffVoid`), and this planner never sees the distinction.
 *
 * **No automatic-refund promise.** A cancellation releases stock; a refund reverses a sale
 * and has its own document (`credit-notes.ts`). The sentence is conditional — "ถ้าโอนเงินมา
 * แล้ว" — because a pre-order is usually unpaid at this point, and an unconditional promise
 * would be a lie the shop has to explain at the counter.
 */
export function planLineCustomerCancelledMessage(
  input: {
    orderId: string;
    orderNumber: string;
    /** The shop's own reason, in the shop's own words. */
    reason: string;
  } & LineCustomerNotifyInput,
  env: Record<string, string | undefined> = process.env,
): CustomerLinePlan | null {
  if (lineCustomerNotifyBlock(input) !== null) {
    return null;
  }

  const why = input.reason.trim().length > 0 ? ` — เหตุผล: ${input.reason.trim()}` : '';

  return {
    recipient: input.customerLineSubject as string,
    text: withEntry(
      `ออเดอร์ ${input.orderNumber} ถูกยกเลิกแล้ว${why} ` +
        'ถ้าโอนเงินมาแล้ว ร้านจะติดต่อคืนเงินให้โดยเร็ว',
      env,
    ),
    orderId: input.orderId,
  };
}

/**
 * The hold is nearly over, and the customer is reminded once.
 *
 * A reminder is not a promotion and not a campaign: it is derived from the order's own
 * deadline and deduped on the order, so it belongs to the transaction-shaped half of the
 * outbox rather than to ADR 0032's scheduled sends. The PIN rides it because the customer
 * may have scrolled past the first message, and the recipient is the same one who was
 * allowed to receive it — this planner refuses exactly where the ready planner does.
 */
export function planLineCustomerReminderMessage(
  input: {
    orderId: string;
    orderNumber: string;
    pickupPin: string;
    holdUntil: Date;
  } & LineCustomerNotifyInput,
  env: Record<string, string | undefined> = process.env,
): CustomerLinePlan | null {
  if (lineCustomerNotifyBlock(input) !== null) {
    return null;
  }

  return {
    recipient: input.customerLineSubject as string,
    text: withEntry(
      `ออเดอร์ ${input.orderNumber} ใกล้หมดเวลารับของแล้ว — ` +
        `รหัสรับของ ${input.pickupPin} ร้านเก็บถึง ${bangkokTimeString(input.holdUntil)} น.`,
      env,
    ),
    orderId: input.orderId,
  };
}

/**
 * The receipt, pushed to the customer's own LINE after handover.
 *
 * **The expiry is stated in the message, and that is the decision.** A receipt link lives
 * for `RECEIPT_LINK_TTL_MINUTES` (60 by default) and never past the one-month access window
 * (`receipt-link.ts`), so a customer who opens the chat tomorrow would find a dead page and
 * no explanation. Saying "ใช้ได้ถึง HH:MM" turns that into an instruction: save it now, or
 * open the receipt again from the orders screen, which keeps it for the whole window.
 *
 * The alternative was a message with no credential at all — "ใบเสร็จพร้อมแล้ว เปิดที่หน้า
 * ออเดอร์" — and it was rejected because the customer asked for the receipt at the counter
 * and a link is what they can save. The exposure is bounded: the token names one order, it
 * dies within the hour, and it is sent only to the person who paid.
 */
export function planLineCustomerReceiptMessage(
  input: {
    orderId: string;
    orderNumber: string;
    receiptUrl: string;
    /** When the link stops verifying — printed, never rounded into "1 ชั่วโมง". */
    expiresAt: Date;
  } & LineCustomerNotifyInput,
  env: Record<string, string | undefined> = process.env,
): CustomerLinePlan | null {
  if (lineCustomerNotifyBlock(input) !== null) {
    return null;
  }

  return {
    recipient: input.customerLineSubject as string,
    text: withEntry(
      `ใบเสร็จบิล ${input.orderNumber} พร้อมแล้ว — ${input.receiptUrl} ` +
        `(ลิงก์ใช้ได้ถึง ${bangkokTimeString(input.expiresAt)} น. หลังจากนั้นเปิดดูซ้ำได้ที่หน้าออเดอร์ของคุณ)`,
      env,
    ),
    orderId: input.orderId,
  };
}

/**
 * Why a ready order's customer has not been told, or did not get told.
 *
 * The four LINE reasons are the planner's own (`lineCustomerNotifyBlock`), so the
 * counter's explanation and the planner's refusal cannot drift. The other three are
 * facts about the *shop*, which the planner never sees because it is handed one channel
 * at a time.
 */
export type CustomerNoticeReason = LineCustomerNotifyBlock | 'no_channel' | 'no_phone';

/** What the board says about one order's ready message. */
export type CustomerNoticeState = 'sent' | 'queued' | 'failed' | 'not_sent' | 'not_ready';

export interface CustomerNoticeOutcome {
  state: CustomerNoticeState;
  /** Null only for `sent`/`queued`/`failed`/`not_ready`; never null for `not_sent`. */
  reason: CustomerNoticeReason | null;
  /** The sentence a card prints, or null when there is nothing to say. */
  sentence: string | null;
}

/**
 * Did the customer hear that their parcel is ready? — asked at the counter.
 *
 * `markOrderReady` plans one message per order and then forgets it, so until now the only
 * way for staff to know whether a customer was told was for the customer to say so. This
 * function reads the same fact from the record (a notification row, if one was written)
 * and, when there is none, from the same refusal the planner used — so "why not" is an
 * answer at the till rather than a shrug.
 *
 * A null `notification` with every LINE condition satisfied means the row was not found:
 * either this read raced the pack, or the message was planned by the other channel. It is
 * reported as `not_sent` with no reason rather than guessed at.
 */
export function customerNoticeOutcome(input: {
  /** The `order_ready` row's status, if one exists for this order. */
  notification: 'sent' | 'pending' | 'abandoned' | null;
  /** The shop's configured outbox channel; null when delivery is off entirely. */
  channel: NotificationChannel | null;
  customerLineSubject: string | null;
  consentAt: Date | null;
  isFriend: boolean;
  customerPhone: string | null;
  /** Whether this order is at the phase that has something to say at all. */
  isReady: boolean;
}): CustomerNoticeOutcome {
  if (!input.isReady) {
    return { state: 'not_ready', reason: null, sentence: null };
  }

  /*
   * The row is the record, so it wins over any re-derivation: a message LINE refused after
   * six attempts is `failed` even though every condition was satisfied when it was queued.
   */
  if (input.notification === 'sent') {
    return { state: 'sent', reason: null, sentence: 'แจ้งเตือนลูกค้าแล้ว' };
  }
  if (input.notification === 'pending') {
    return { state: 'queued', reason: null, sentence: 'แจ้งเตือนอยู่ในคิว — จะออกในไม่กี่วินาที' };
  }
  if (input.notification === 'abandoned') {
    return {
      state: 'failed',
      reason: null,
      sentence: 'ส่งแจ้งเตือนไม่สำเร็จ — ตรวจช่องทางและคิวที่หน้า LINE และโปรโมชัน',
    };
  }

  if (input.channel === null) {
    return { state: 'not_sent', reason: 'no_channel', sentence: NO_REASON_SENTENCE.no_channel };
  }

  if (input.channel === 'line') {
    const reason = lineCustomerNotifyBlock({
      channel: input.channel,
      staffTo: null,
      customerLineSubject: input.customerLineSubject,
      consentAt: input.consentAt,
      isFriend: input.isFriend,
    });
    return {
      state: 'not_sent',
      reason,
      sentence: reason === null ? 'ยังไม่ได้ส่งแจ้งเตือน' : NO_REASON_SENTENCE[reason],
    };
  }

  /*
   * A webhook shop texts the customer, which needs a phone number — the one requirement the
   * LINE planner never has to think about, and the one this channel fails on.
   */
  if ((input.customerPhone ?? '').trim().length === 0) {
    return { state: 'not_sent', reason: 'no_phone', sentence: NO_REASON_SENTENCE.no_phone };
  }
  return { state: 'not_sent', reason: null, sentence: 'ยังไม่ได้ส่งแจ้งเตือน' };
}

/**
 * One sentence per reason, written as what the *shop* can do — the same rule
 * `linePromoBlockSentence` follows: a customer who withdrew is not going to be re-asked by
 * a red banner, and a customer who has not added the shop as a friend is a person the
 * counter can tell about the friend step.
 */
const NO_REASON_SENTENCE: Record<CustomerNoticeReason, string> = {
  channel_not_line: 'ไม่ได้ส่งทาง LINE — ร้านตั้งช่องทางแจ้งเตือนเป็นอย่างอื่น',
  not_bound: 'ยังไม่แจ้งลูกค้า — ลูกค้ายังไม่ได้ผูกบัญชี LINE',
  no_consent: 'ยังไม่แจ้งลูกค้า — ลูกค้ายังไม่ยินยอมรับแจ้งเตือน',
  not_a_friend: 'ยังไม่แจ้งลูกค้า — ลูกค้ายังไม่ได้เพิ่มเพื่อนร้านใน LINE',
  no_channel: 'ยังไม่แจ้งลูกค้า — ร้านยังไม่ได้ตั้งช่องทางแจ้งเตือน',
  no_phone: 'ยังไม่แจ้งลูกค้า — ไม่มีเบอร์โทรของลูกค้า',
};

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
