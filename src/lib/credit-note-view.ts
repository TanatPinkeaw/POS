/**
 * A credit note, as the till and the printer see it.
 *
 * The same split as `shop-view.ts`/`shop.ts` and `audit-view.ts`/`audit.ts`: the
 * shapes and the Thai labels a screen needs are here, and the queries, the
 * numbering and the transaction are in `credit-notes.ts`. Nothing in this file
 * may import the database, because the refund sheet at the till is a client
 * component.
 */
import type { TenderLine } from './tender';

/**
 * How the money went back to the customer.
 *
 * Two options, and neither is a payment provider. **This is the constraint the
 * whole design follows from:** sending money back automatically would need a
 * bank API relationship and a fee per transfer, so a refund is either cash out
 * of the drawer the shop already reconciles, or a transfer the cashier makes by
 * hand in the shop's own banking app — which the credit note records but does
 * not perform.
 *
 * The distinction is not cosmetic. A cash refund moves money the drawer counted,
 * so it must be written against the open shift and it must make the close
 * reconcile. A hand-made transfer never touched the drawer, so writing it
 * against one would invent a shortage at close — the same reason a points leg
 * carries no `shift_id` when a pre-order is collected.
 */
export type RefundMethod = 'cash' | 'promptpay';

export interface RefundMethodOption {
  value: RefundMethod;
  label: string;
  help: string;
}

export const REFUND_METHODS: readonly RefundMethodOption[] = [
  {
    value: 'cash',
    label: 'เงินสดจากลิ้นชัก',
    help: 'หักออกจากลิ้นชักที่เปิดอยู่ — ยอดปิดกะจะตรงที่สุด',
  },
  {
    value: 'promptpay',
    label: 'โอนคืนผ่านแอปธนาคาร',
    help: 'โอนเองจากแอปของร้าน แล้วบันทึกไว้ — ไม่กระทบยอดปิดกะ',
  },
];

export function refundMethodLabel(method: RefundMethod): string {
  return REFUND_METHODS.find((option) => option.value === method)?.label ?? 'เงินสด';
}

/** One line of the original sale, as the credit note restates it. */
export interface DocumentLine {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

/**
 * The credit note as a printable document.
 *
 * Its tax figures come from the credit note's own snapshot columns, never from
 * the sale it reverses: the note is the document that was issued, and a reprint
 * of it must be identical even if the shop's VAT rate has changed since. Same
 * rule as a receipt (ADR 0002), for the same reason.
 */
export interface CreditNoteDocument {
  documentNumber: string;
  issuedAt: string;
  reason: string;
  refundMethod: RefundMethod;
  refundMethodLabel: string;
  finalAmountThb: number;
  netThb: number;
  vatThb: number;
  vatRatePercent: number | null;
  /** Mirrors the sale: a credit note only carries a tax line if the sale did. */
  isVatInvoice: boolean;
  pointsClawedBack: number;
  pointsForgiven: number;
  issuedBy: string;
  approvedBy: string | null;
  /** What is being reversed — the sale, and how it was paid. */
  original: {
    orderNumber: string;
    receiptNumber: string | null;
    soldAt: string;
    soldBy: string | null;
    tenders: TenderLine[];
    lines: DocumentLine[];
    changeThb: number;
  };
}

/** What the till shows after a refund it just performed. */
export interface RefundSummary {
  orderId: string;
  orderNumber: string;
  status: 'refunded';
  documentNumber: string;
  finalAmountThb: number;
  refundMethod: RefundMethod;
  returnedLines: number;
  returnedUnits: number;
  pointsClawedBack: number;
  pointsForgiven: number;
}
