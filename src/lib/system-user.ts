/**
 * The automated actor.
 *
 * `stock_logs.changed_by` is NOT NULL and references `users` (SRS §7), so a
 * movement the system makes on its own — expiring an unconfirmed pre-order —
 * still needs an attributable user. Rather than weakening that constraint, the
 * seed creates this fixed account and automation reports as it.
 *
 * The UUID is a constant so the expiry sweeper never has to look it up.
 */
export const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000001';
export const SYSTEM_USER_PHONE = '0000000000';
export const SYSTEM_USER_NAME = 'ระบบอัตโนมัติ (System)';
