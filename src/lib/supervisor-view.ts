/**
 * Supervisor approval, as the browser sees it.
 *
 * Client-safe half of `supervisor.ts`, on the same split as
 * `shop-view.ts`/`shop.ts`: the constants and the pure validation are needed by
 * the PIN dialog itself (so it can refuse a malformed PIN without a round trip),
 * while the hashing and the token signing are not.
 */

/**
 * Four digits, like the reference design and like every other till in the
 * country. Short enough to type with a customer watching, which is the whole
 * reason it exists: a supervisor approves without signing the till out.
 */
export const PIN_LENGTH = 4;

/** Wrong guesses before the PIN locks. */
export const MAX_PIN_ATTEMPTS = 5;

/** How long the lock lasts. */
export const PIN_LOCK_MINUTES = 5;

/**
 * How long one approval stays usable.
 *
 * Long enough for a cashier to walk a PIN request through and for the retried
 * request to land, short enough that an approval cannot be banked for later. The
 * token is also bound to the action, the target and the person who asked, so a
 * leaked one is worth far less than its lifetime suggests.
 */
export const APPROVAL_TTL_SECONDS = 90;

/** The header a gated request carries its approval in. */
export const APPROVAL_HEADER = 'x-supervisor-token';

/**
 * The actions a cashier may not take alone.
 *
 * Deliberately a closed union rather than `string`: every gated action needs a
 * place in the audit vocabulary, an approval prompt that says something
 * meaningful about it, and a test. A free-text action would let a caller invent
 * a gate that no screen can ask for.
 */
export type SupervisorAction =
  | 'void_order'
  | 'refund_order'
  | 'over_discount'
  | 'drawer_open'
  | 'manual_payment_confirm';

export const SUPERVISOR_ACTIONS: readonly SupervisorAction[] = [
  'void_order',
  'refund_order',
  'over_discount',
  'drawer_open',
  'manual_payment_confirm',
];

/** What the approval dialog asks permission for. */
export const SUPERVISOR_ACTION_LABELS: Record<SupervisorAction, string> = {
  void_order: 'ยกเลิกบิล',
  refund_order: 'คืนเงินและออกใบลดหนี้',
  over_discount: 'ให้ส่วนลดเกินวงเงิน',
  drawer_open: 'เปิดลิ้นชักโดยไม่มีการขาย',
  manual_payment_confirm: 'ยืนยันเงินเข้าเอง',
};

/**
 * What an over-limit discount approval is bound to.
 *
 * The order does not exist yet when the approval is asked for, so the amount is
 * the only thing there is to bind to. That is the property that matters anyway:
 * an approval for a 60 baht discount must not authorise a 600 baht one, and a
 * token bound to this string cannot be spent on a different figure.
 *
 * Lives here, not in the server module, because both sides compute it: the till
 * when it asks, and the route when it checks.
 */
export function discountApprovalTarget(discountThb: number): string {
  return `discount:${discountThb.toFixed(2)}`;
}

/** An admin who can approve, for the dialog's picker. No emails, no phones. */
export interface SupervisorOption {
  id: string;
  fullName: string;
}

/** What the staff screen needs to know about someone's PIN. */
export interface SupervisorStatus {
  hasPin: boolean;
  lockedUntil: string | null;
}

/** Whether a PIN is locked right now. */
export function isLocked(status: SupervisorStatus, now: Date = new Date()): boolean {
  return status.lockedUntil !== null && new Date(status.lockedUntil) > now;
}

/**
 * What is wrong with a PIN, or null when it is acceptable.
 *
 * Three rules, and the second and third exist because a four-digit PIN has only
 * ten thousand values: `0000`, `1111` and `1234` are the guesses an attacker who
 * is not trying very hard will make first, and refusing them costs the shop
 * nothing. Longer PINs would not need this, but they would also not get typed in
 * front of a queue.
 */
export function pinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    return `PIN ต้องเป็นตัวเลข ${PIN_LENGTH} หลัก`;
  }
  if (/^(\d)\1+$/.test(pin)) {
    return 'PIN ต้องไม่เป็นตัวเลขซ้ำกันทั้ง 4 ตัว';
  }
  if (isConsecutiveRun(pin)) {
    return 'PIN ต้องไม่เรียงติดกัน เช่น 1234 หรือ 4321';
  }
  return null;
}

/** `1234` and `4321`, in either direction. `9012` is allowed: it does not run. */
function isConsecutiveRun(pin: string): boolean {
  const digits = [...pin].map(Number);
  const steps = digits.slice(1).map((digit, index) => digit - digits[index]);
  return steps.every((step) => step === 1) || steps.every((step) => step === -1);
}
