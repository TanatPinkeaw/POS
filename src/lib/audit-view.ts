/**
 * The audit trail, as the browser sees it.
 *
 * Separate from `audit.ts` for the same reason `shop-view.ts` is separate from
 * `shop.ts`: that one owns the database and is server-only, this one is safe to
 * import from a client component. The Thai labels live here rather than in the
 * component so that the events list and the audit screen cannot disagree about
 * what an action is called.
 */

/** Every action the trail can record. Mirrors the `audit_action` enum. */
export type AuditAction =
  | 'void_order'
  | 'refund_order'
  | 'over_discount'
  | 'drawer_open'
  | 'manual_payment_confirm'
  | 'pin_set'
  | 'pin_reset'
  | 'pin_locked'
  | 'display_paired'
  | 'display_revoked';

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'void_order',
  'refund_order',
  'over_discount',
  'drawer_open',
  'manual_payment_confirm',
  'pin_set',
  'pin_reset',
  'pin_locked',
  'display_paired',
  'display_revoked',
];

/**
 * What each action is called on screen.
 *
 * Written from the shop's point of view rather than the system's: an owner
 * reading this list is asking "what happened at my counter", so it says
 * ยกเลิกบิล and ส่วนลดเกินวงเงิน rather than `void_order` and `over_discount`.
 */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  void_order: 'ยกเลิกบิล',
  refund_order: 'คืนเงิน (ใบลดหนี้)',
  over_discount: 'ส่วนลดเกินวงเงิน',
  drawer_open: 'เปิดลิ้นชัก',
  manual_payment_confirm: 'ยืนยันเงินเข้าเอง',
  pin_set: 'ตั้ง PIN ผู้ดูแล',
  pin_reset: 'เปลี่ยน PIN ผู้ดูแล',
  pin_locked: 'PIN ถูกล็อก',
  display_paired: 'เพิ่มจอลูกค้า',
  display_revoked: 'ยกเลิกจอลูกค้า',
};

/**
 * Tone per action, for the trail's own colour coding.
 *
 * Not every recorded action is a problem: pairing a display is routine, while a
 * void is the thing an owner scrolls the list looking for. Marking them the same
 * way would bury the second in the first.
 *
 * The values are the design system's own tones rather than a vocabulary of this
 * file's invention: a trail that invented "attention" would need its own colour,
 * and then the same shade of amber would mean one thing here and another on the
 * dashboard.
 */
export type AuditTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success' | 'brand';

export const AUDIT_ACTION_TONES: Record<AuditAction, AuditTone> = {
  void_order: 'danger',
  // Money leaving the drawer is at least as interesting as a void, and an owner
  // scrolling for "where did the cash go" must not have to read every row.
  refund_order: 'danger',
  over_discount: 'warning',
  drawer_open: 'info',
  manual_payment_confirm: 'warning',
  pin_set: 'neutral',
  pin_reset: 'info',
  pin_locked: 'danger',
  display_paired: 'neutral',
  display_revoked: 'neutral',
};

/**
 * How much of the trail one page shows, and the ceiling a caller may ask for.
 *
 * Shared with the request schema, so the number the UI pages by and the number
 * the API is willing to return cannot drift apart.
 */
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_PAGE_SIZE_MAX = 200;

export interface AuditActor {
  id: string;
  fullName: string;
}

export interface AuditRow {
  /** BigInt in the database; a string here, because JSON has no BigInt. */
  id: string;
  action: AuditAction;
  /** Who was at the till. */
  actor: AuditActor | null;
  /** Whose PIN approved it. Equal to `actor` when an owner approves their own. */
  authorizedBy: AuditActor | null;
  targetType: string | null;
  targetId: string | null;
  shiftId: number | null;
  detail: Record<string, unknown> | null;
  /** ISO instant. */
  createdAt: string;
}

/**
 * A one-line description of what the row is about.
 *
 * Built from `targetType`/`targetId`/`detail` rather than stored as prose, so the
 * trail stays queryable — a stored sentence is a sentence nobody can filter on.
 */
export function auditTargetLabel(row: AuditRow): string {
  switch (row.action) {
    case 'void_order':
      return row.targetId ? `บิล ${row.targetId}` : 'บิล';
    case 'over_discount': {
      const amount = row.detail?.discountThb;
      const limit = row.detail?.limitThb;
      return typeof amount === 'number'
        ? `ส่วนลด ${amount.toFixed(2)} บาท${typeof limit === 'number' ? ` (เกิน ${limit.toFixed(2)})` : ''}`
        : 'ส่วนลด';
    }
    case 'manual_payment_confirm': {
      const amount = row.detail?.amountThb;
      return typeof amount === 'number' ? `ยอด ${amount.toFixed(2)} บาท` : 'ยืนยันเงินเข้า';
    }
    case 'drawer_open':
      return row.shiftId === null ? 'ลิ้นชัก' : `ลิ้นชัก #${row.shiftId}`;
    case 'display_paired':
    case 'display_revoked':
      return typeof row.detail?.label === 'string' ? `จอ "${row.detail.label}"` : 'จอลูกค้า';
    case 'pin_set':
    case 'pin_reset':
    case 'pin_locked':
      return row.targetId ? `ผู้ใช้ ${row.targetId}` : 'ผู้ใช้';
    default:
      return row.targetId ?? '';
  }
}
