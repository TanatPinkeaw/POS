/**
 * Promotion consent — the second consent, and why it is not the first (ADR 0032 §5).
 *
 * The shop already has one consent: `line_consent_at` means "tell me my order is ready",
 * and a customer grants it by placing an order. A promotion is a different purpose with a
 * different risk — nobody was promised a discount when they ordered — so it gets its own
 * two timestamps and its own version of the text shown.
 *
 * Pure, and no `prisma` import: the state is a function of the two timestamps, so the
 * interesting case — agreed, withdrew, agreed again — is a unit test rather than a database
 * fixture. Same split as `line-door.ts` and `line-liff-entry.ts`.
 *
 * **The later timestamp wins.** That is the whole state machine, and it is the honest one:
 * a withdrawal is an act rather than a deletion, so the row keeps both facts and the shop
 * can say what happened in order. A tie is impossible in practice (one row is written by one
 * update) and is resolved to `withdrawn` anyway, because the safe direction for a promotion
 * is silence.
 */
import type { NotificationChannel } from './notify-message';

/**
 * Version marker on the promotion text, bumped when the wording changes materially.
 *
 * Separate from `LINE_CONSENT_VERSION` because it is separate wording: a customer who agreed
 * to order notifications has not agreed to this, and one version string covering both would
 * make the audit row unable to say which sentence was shown.
 */
export const LINE_PROMO_CONSENT_VERSION = '2026-10-14';

/** Where one customer stands on promotions, in three states rather than a boolean. */
export type LinePromoConsentState =
  /** Never offered, or offered and never answered. The card may offer the choice. */
  | 'never_asked'
  /** Agreed, and not withdrawn since. A campaign may reach them. */
  | 'consented'
  /** Said no. The card must **not** offer it again — it may only show how to change it. */
  | 'withdrawn';

/** The two timestamps, as the row holds them. */
export interface LinePromoConsentInput {
  consentAt: Date | null;
  withdrawnAt: Date | null;
}

/** Which of the two timestamps wins: the later one, and a withdrawal on a tie. */
export function linePromoConsentState(input: LinePromoConsentInput): LinePromoConsentState {
  const { consentAt, withdrawnAt } = input;
  if (consentAt === null && withdrawnAt === null) {
    return 'never_asked';
  }
  if (withdrawnAt === null) {
    return 'consented';
  }
  if (consentAt === null) {
    return 'withdrawn';
  }
  return consentAt.getTime() > withdrawnAt.getTime() ? 'consented' : 'withdrawn';
}

/**
 * Why a campaign cannot reach this customer, in the shape `lineCustomerNotifyBlock` set.
 *
 * The first reason in the order below is the one the screen says, so the order is the
 * decision: an unconfigured channel is not about this customer at all, no address outranks
 * no consent (there is nothing to be consented to), consent outranks the friend condition —
 * because a customer who never agreed is not somebody the shop should be reminding to add
 * the shop as a friend.
 */
export type LinePromoBlock =
  | 'channel_not_line'
  | 'not_bound'
  | 'never_asked'
  | 'withdrawn'
  | 'not_a_friend';

/** What the eligibility rule needs; every fact read by the caller. */
export interface LinePromoEligibilityInput extends LinePromoConsentInput {
  channel: NotificationChannel | null;
  /** The bound LINE subject, or null for a customer with no LINE account. */
  customerLineSubject: string | null;
  /** Read from `line_friends` by the caller, so this stays pure. */
  isFriend: boolean;
}

/** The first reason a promotion cannot reach this customer, or null when it can. */
export function linePromoConsentBlock(input: LinePromoEligibilityInput): LinePromoBlock | null {
  if (input.channel !== 'line') {
    return 'channel_not_line';
  }
  if (input.customerLineSubject === null) {
    return 'not_bound';
  }
  const state = linePromoConsentState(input);
  if (state === 'never_asked') {
    return 'never_asked';
  }
  if (state === 'withdrawn') {
    return 'withdrawn';
  }
  if (!input.isFriend) {
    return 'not_a_friend';
  }
  return null;
}

/** Whether a campaign may reach this customer, asked the way a caller thinks about it. */
export function canReceivePromotions(input: LinePromoEligibilityInput): boolean {
  return linePromoConsentBlock(input) === null;
}

/**
 * One Thai sentence per block, because a reason a screen cannot say is a reason a counter
 * cannot act on.
 *
 * The sentences say what the *shop* can do rather than what the customer failed to do: a
 * customer who withdrew is not going to be re-asked by a red banner, and a customer who
 * never added the shop as a friend is a person the shop can tell about the friend step.
 */
export function linePromoBlockSentence(block: LinePromoBlock): string {
  switch (block) {
    case 'channel_not_line':
      return 'ร้านยังไม่ได้ตั้งค่าช่องทาง LINE จึงยังส่งโปรโมชันไม่ได้';
    case 'not_bound':
      return 'ลูกค้ายังไม่ได้ผูกบัญชี LINE — ส่งโปรโมชันไปไม่ถึง';
    case 'never_asked':
      return 'ยังไม่เคยขอความยินยอมรับโปรโมชัน';
    case 'withdrawn':
      return 'ลูกค้าเคยยกเลิกรับโปรโมชันไว้ — ต้องให้ลูกค้ากดยินยอมใหม่เอง';
    case 'not_a_friend':
      return 'ลูกค้ายังไม่ได้เพิ่มเพื่อนร้านใน LINE — ข้อความจะส่งไม่ถึง';
  }
}

/**
 * What the card says about this customer's own state, which is not the same question as
 * whether a campaign may reach them.
 *
 * The friend condition is deliberately absent: it is checked at send time, so the card must
 * not claim to know it (the same reason `lineCustomerNotifyBlock` is not what the account
 * page prints). A customer reading their own screen has answered the consent question and
 * nothing else.
 */
export function linePromoConsentSentence(state: LinePromoConsentState): string {
  switch (state) {
    case 'never_asked':
      return 'ยังไม่ได้เลือกเรื่องโปรโมชัน — กดยินยอมได้ตลอดเวลา และถ้าไม่กดก็ยังรับแจ้งเตือนออเดอร์ตามปกติ';
    case 'consented':
      return 'ยินยอมรับโปรโมชันแล้ว — ยกเลิกได้ตลอดเวลา และแจ้งเตือนออเดอร์ยังมาปกติ';
    case 'withdrawn':
      return 'ยกเลิกรับโปรโมชันไว้ — ทางร้านจะไม่ส่งโปรโมชันให้อีก จนกว่าคุณจะกดยินยอมใหม่ (แจ้งเตือนออเดอร์ยังมาปกติ)';
  }
}

/**
 * The label of the act this state offers.
 *
 * Three sentences rather than a sentence and its negation, because `withdrawn` is not the
 * same as `never_asked`: a customer who said no is offered the act *again*, named as one, and
 * that is a different thing from being asked for the first time. (The withdrawal is the
 * customer's own to reverse — PDPA-style honesty runs both ways, and this repository has
 * already recorded that nothing is demanded to stop being reachable.)
 */
export function linePromoActionLabel(state: LinePromoConsentState): string {
  switch (state) {
    case 'never_asked':
      return 'ยินยอมรับโปรโมชัน';
    case 'consented':
      return 'ยกเลิกรับโปรโมชัน';
    case 'withdrawn':
      return 'ยินยอมรับโปรโมชันอีกครั้ง';
  }
}
