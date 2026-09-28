/**
 * The shape of a recorded transfer as a screen sees it, and the words it uses.
 *
 * Split from `inbound-payments.ts` for the reason every `-view` module here is:
 * the labels are read by a component, and a component that imports the module
 * holding Prisma drags the database client into its bundle. The refusal reasons
 * are a closed set defined by the matcher, so they are imported as a *type* from
 * the pure module rather than restated.
 */
import type { InboundRefusalReason } from './inbound-match';

export type { InboundRefusalReason } from './inbound-match';

export type InboundStatus = 'matched' | 'unmatched' | 'dismissed';

export interface InboundTransferView {
  id: string;
  /** Null when the notification held no readable amount; `rawText` is the evidence. */
  amountThb: number | null;
  /** The instant the bank says the money moved. */
  receivedAt: Date;
  source: string;
  status: InboundStatus;
  refusalReason: InboundRefusalReason | null;
  /** The QR that was closed by this transfer, when one was. */
  intentRef: string | null;
  /** The notification itself, kept so a person can read what the bank said. */
  rawText: string;
  dismissedReason: string | null;
  createdAt: Date;
}

/**
 * Why the system would not attribute this money, in the operator's words.
 *
 * Each one names a different next action, which is the only test that matters for
 * copy on a screen like this: `amount_unreadable` means the shop's bridge needs
 * its pattern looked at, `no_reference` means ring the customer, `ambiguous`
 * means look at both QRs, and `not_payable` usually means the notification is the
 * second half of a pair already dealt with.
 */
export const INBOUND_REFUSAL_LABELS: Record<InboundRefusalReason, string> = {
  amount_unreadable: 'อ่านยอดเงินจากข้อความไม่ได้',
  no_amount_match: 'ยอดไม่ตรงกับ QR ใดเลย',
  no_reference: 'ลูกค้าไม่ได้กรอกเลขอ้างอิง',
  ambiguous: 'ข้อความอ้างถึงหลายรายการ',
  not_payable: 'QR หมดอายุหรือปิดบิลไปแล้ว',
};
