/**
 * Shop settings as the browser sees them.
 *
 * Separate from `shop.ts` for the same reason `attendance-view.ts` is separate
 * from `attendance.ts`: that one owns the database and the row's `Decimal`s, and
 * this one is safe to import from a client component.
 */
import type { PromptPayIdType } from './promptpay';
import { formatTaxRate } from './vat';

export interface ShopView {
  name: string;
  legalName: string | null;
  branchLabel: string | null;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  isVatRegistered: boolean;
  /** A percentage, e.g. `7`. */
  vatRate: number;
  /** Inclusive pricing is the Thai retail norm, and the only mode supported. */
  pricesIncludeVat: boolean;
  receiptPrefix: string;
  receiptRunningNumber: number;
  receiptFooter: string | null;
  logoUrl: string | null;
  /**
   * Where the shop receives PromptPay transfers.
   *
   * Null is a real state, not a gap: the till then has no way to issue a QR and
   * falls back to a cashier confirming the transfer by hand, which is what every
   * sale did before this existed.
   */
  promptpayId: string | null;
  promptpayType: PromptPayIdType | null;
  /**
   * The discount a cashier may give without a supervisor's PIN.
   *
   * Part of the shop's view rather than of the till's state because it is
   * policy: one shop says 50 baht, another says 200, and the number belongs
   * beside the VAT rate and the receipt series rather than in a component.
   */
  supervisorDiscountLimitThb: number;
}

/** The current Thai standard rate, used as the wizard's default. */
export const DEFAULT_VAT_RATE = 7;

/** Prefix for the first receipt series, before a renter renames it. */
export const DEFAULT_RECEIPT_PREFIX = 'RC';

/** Prefix for the first credit-note series, before a renter renames it. */
export const DEFAULT_CREDIT_NOTE_PREFIX = 'CN';

/**
 * The discount limit a shop starts with, before it sets its own.
 *
 * Fifty baht because that is roughly the largest round-off a cashier can make
 * from habit rather than from policy — big enough not to interrupt a normal
 * sale, small enough that using it as a discount channel is visible.
 */
export const DEFAULT_SUPERVISOR_DISCOUNT_LIMIT = 50;

/**
 * What the app shows before setup has run.
 *
 * Every surface that can render pre-setup (the setup wizard itself, and the
 * receipt defaults) reads this rather than inventing its own placeholder, so
 * "unconfigured" looks the same everywhere.
 */
export const UNCONFIGURED_SHOP: ShopView = {
  name: '',
  legalName: null,
  branchLabel: null,
  taxId: null,
  address: null,
  phone: null,
  isVatRegistered: false,
  vatRate: DEFAULT_VAT_RATE,
  pricesIncludeVat: true,
  receiptPrefix: DEFAULT_RECEIPT_PREFIX,
  receiptRunningNumber: 0,
  receiptFooter: null,
  logoUrl: null,
  promptpayId: null,
  promptpayType: null,
  // A shop that has not been set up has no policy yet, so it starts at the
  // default rather than at zero: zero would make every discount require a PIN,
  // and a shop with no admins configured could not discount at all.
  supervisorDiscountLimitThb: DEFAULT_SUPERVISOR_DISCOUNT_LIMIT,
};

/** What to print at the top of a receipt, and in the sidebar. */
export function shopDisplayName(shop: ShopView | null): string {
  const name = shop?.name?.trim();
  return name && name.length > 0 ? name : 'ร้านของฉัน';
}

/** `RC-2026-000001`. */
export function formatReceiptNumber(prefix: string, year: number, running: number): string {
  const safePrefix = prefix.trim() === '' ? DEFAULT_RECEIPT_PREFIX : prefix.trim();
  return `${safePrefix}-${year}-${running.toString().padStart(6, '0')}`;
}

/**
 * `CN-2026-000001`.
 *
 * Deliberately the same shape as a receipt number, because the two are read
 * against each other: a credit note that does not look like the document it
 * reverses makes an auditor's job harder for no gain. Only the prefix differs,
 * and a shop can change that one to whatever its accountant prefers.
 */
export function formatCreditNoteNumber(prefix: string, year: number, running: number): string {
  const safePrefix = prefix.trim() === '' ? DEFAULT_CREDIT_NOTE_PREFIX : prefix.trim();
  return `${safePrefix}-${year}-${running.toString().padStart(6, '0')}`;
}

/**
 * The number the next sale would be issued.
 *
 * Shown on the settings screen so an operator can see the series is continuous
 * *before* the first customer is standing at the till, rather than discovering a
 * gap on a printed document.
 */
export function nextReceiptPreview(shop: ShopView, year: number): string {
  return formatReceiptNumber(shop.receiptPrefix, year, shop.receiptRunningNumber + 1);
}

/**
 * Whether the till can issue a PromptPay QR at all.
 *
 * Asked from both sides — the till decides whether to offer a QR or a manual
 * confirmation, and the server refuses to mint one — so the two screens cannot
 * disagree about a shop that has not configured it.
 */
export function canIssuePromptPayQr(shop: ShopView | null): boolean {
  return Boolean(shop?.promptpayId && shop.promptpayType);
}

/** True when a receipt may be issued with a tax line at all. */
export function issuesTaxInvoice(shop: ShopView | null): boolean {
  return Boolean(shop?.isVatRegistered);
}

/** `13 หลัก` hint / validation for the tax id field. */
export function isTaxIdShaped(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === '' || /^\d{13}$/.test(value);
}

/**
 * What a VAT line reads on a receipt: `VAT 7%`.
 *
 * Built on `formatTaxRate` rather than formatting the rate a second time, so the
 * settings screen and the printed receipt cannot disagree about 7% vs 7.00%.
 */
export function vatLabel(ratePercent: number): string {
  return `VAT ${formatTaxRate(ratePercent)}`;
}
