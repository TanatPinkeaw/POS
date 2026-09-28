/**
 * Payment intents, as the browser sees them.
 *
 * Client-safe half of `payment-intents.ts`, on the same split as
 * `shop-view.ts`/`shop.ts`. The customer display needs the amount, the reference,
 * the QR payload and the status — and nothing else: no cashier id, no shift, no
 * order internals, because whatever this module declares is what gets broadcast
 * to a screen standing in the middle of the shop.
 */

export type PaymentIntentStatus = 'pending' | 'paid' | 'expired' | 'cancelled' | 'consumed';

export interface PaymentIntentView {
  id: string;
  /** The short code shown to the customer and quoted back by a confirmation. */
  ref: string;
  amountThb: number;
  /** The EMVCo payload, rendered as a QR by whoever holds it. */
  qrPayload: string;
  status: PaymentIntentStatus;
  /** ISO instant. The countdown on both screens is derived from this. */
  expiresAt: string;
  paidAt: string | null;
}

/** Whether this intent can still be paid. */
export function isPayable(intent: PaymentIntentView, now: Date = new Date()): boolean {
  return intent.status === 'pending' && new Date(intent.expiresAt) > now;
}

/**
 * Seconds left, floored at zero.
 *
 * Computed from the server's expiry rather than from a local countdown, so a
 * screen that slept or a tab that was backgrounded shows the truth when it wakes
 * instead of however much time it thinks has passed.
 */
export function secondsRemaining(intent: PaymentIntentView, now: Date = new Date()): number {
  return Math.max(0, Math.floor((new Date(intent.expiresAt).getTime() - now.getTime()) / 1000));
}

/** `4:59` — minutes and seconds, for a countdown a customer reads at a glance. */
export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export const PAYMENT_INTENT_STATUS_LABELS: Record<PaymentIntentStatus, string> = {
  pending: 'รอรับเงิน',
  paid: 'เงินเข้าแล้ว',
  expired: 'หมดเวลา',
  cancelled: 'ยกเลิก',
  consumed: 'ปิดบิลแล้ว',
};
