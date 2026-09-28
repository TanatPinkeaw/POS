/**
 * Tender lines.
 *
 * `รับเงิน` on a Thai receipt is not the amount applied to the bill: it is what the
 * customer actually handed over or transferred. A ฿35 bill paid with a ฿100 note
 * prints `รับเงิน 100.00` and `เงินทอน 65.00`, and a PromptPay bill prints the
 * transfer rather than a cash figure nobody handled — which is why the printed
 * amount cannot be derived from the order total.
 *
 * Both paths build these lines from the same shape: one entry per money leg of the
 * settlement, in the order the settlement applied them. `payments` stores one row
 * per leg already (`src/lib/settlement.ts`), so a reprint and an instant receipt
 * describe the same tender.
 */

export interface TenderLine {
  /** `cash` or `promptpay`; points are a discount, not money, and never appear. */
  method: string;
  /** What this leg applied towards the bill. */
  amountThb: number;
  /** Cash physically handed over; null for a transfer. */
  receivedThb: number | null;
}

/** Thai labels, as printed on the document. */
const TENDER_LABELS: Record<string, string> = {
  cash: 'รับเงินสด',
  promptpay: 'รับโอน (พร้อมเพย์)',
};

export function tenderLabel(method: string): string {
  return TENDER_LABELS[method] ?? 'รับเงิน';
}

/**
 * The figure to print for a leg: what was handed over rather than what was
 * applied, so the tender line and the change line always subtract correctly.
 */
export function tenderedAmount(line: TenderLine): number {
  return line.receivedThb ?? line.amountThb;
}
