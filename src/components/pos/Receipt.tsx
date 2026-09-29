/**
 * The receipt (ADR 0002).
 *
 * One component for both paths — the modal shown the instant a sale completes and
 * the reprint of a completed order — because a reprinted tax document that differs
 * from the one the customer holds is worse than no reprint at all.
 *
 * It renders from *snapshotted* values: `vatRatePercent` and the tax lines come
 * from the order, not from the shop's current settings. If the rate ever changes,
 * reprinting a 2026 receipt must still show what was charged in 2026.
 *
 * Pure presentational, no hooks and no data access, so it is equally usable from a
 * client component and a server-rendered page — and it prints at 80mm through the
 * `.ln-receipt-sheet` rules in `base.css`, which is why the same element carries both
 * classes.
 */
import { bangkokDayString, bangkokTimeString } from '@/lib/bangkok-time';
import type { ShopView } from '@/lib/shop-view';
import { vatLabel } from '@/lib/shop-view';
import { tenderedAmount, tenderLabel, type TenderLine } from '@/lib/tender';

import styles from './Receipt.module.css';

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface ReceiptData {
  orderNumber: string;
  /** The gapless invoice number, when the sale issued a tax document. */
  receiptNumber: string | null;
  /**
   * The number the customer is called by (ADR 0017), already printed the way it
   * will be called out — `037`, not `37`. Null on a pre-order and on any bill
   * closed before the first round of call numbers existed.
   */
  queueNumber: string | null;
  isVatInvoice: boolean;
  vatRatePercent: number | null;
  netThb: number;
  vatThb: number;
  subtotalThb: number;
  discountThb: number;
  finalAmountThb: number;
  /**
   * Money handed over, one entry per method. This is what `รับเงิน` prints, so a
   * ฿35 bill paid with a ฿100 note shows 100.00 beside a 65.00 change line.
   */
  tenders: TenderLine[];
  changeThb: number;
  pointsEarned: number;
  pointsRedeemed: number;
  lines: ReceiptLine[];
  /** ISO instant; optional because a just-completed sale may not have one yet. */
  createdAt?: string;
}

const baht = (amount: number): string => amount.toFixed(2);

export function Receipt({
  shop,
  data,
  when,
}: {
  shop: ShopView;
  data: ReceiptData;
  /** Overrides `data.createdAt` — the reprint passes the order's own timestamp. */
  when?: string;
}) {
  const timestamp = when ?? data.createdAt;
  const moment = timestamp ? new Date(timestamp) : new Date();

  /**
   * The document's own name, and it is a legal statement rather than a label: a
   * VAT-registered shop is required to issue an invoice, a shop that is not must
   * not pretend to. This is the one string on the page a tax accountant signs off.
   */
  const title = data.isVatInvoice
    ? 'ใบกำกับภาษีอย่างย่อ / ใบเสร็จรับเงิน'
    : 'ใบเสร็จรับเงิน';

  return (
    <div className={`${styles.receipt} ln-receipt-sheet`} data-testid="receipt">
      <header className={styles.head}>
        <p className={styles.shopName}>{shop.name}</p>
        {shop.branchLabel ? <p className={styles.small}>{shop.branchLabel}</p> : null}
        {shop.address ? <p className={styles.small}>{shop.address}</p> : null}
        {shop.phone ? <p className={styles.small}>โทร. {shop.phone}</p> : null}
        {data.isVatInvoice && shop.taxId ? (
          <p className={styles.small}>เลขประจำตัวผู้เสียภาษี {shop.taxId}</p>
        ) : null}
      </header>

      <p className={styles.title}>{title}</p>

      {/*
        The call number sits above the document's own number rather than beside
        it. Everything below this point is a record of a transaction; this is the
        one figure on the page that is not, and a customer holds this slip while
        their drink is being made, reading it from wherever they sat down.
      */}
      {data.queueNumber ? (
        <div className={styles.call} data-testid="receipt-queue">
          <span className={styles.callLabel}>คิวที่</span>
          <span className={styles.callNumber}>{data.queueNumber}</span>
        </div>
      ) : null}

      <div className={styles.row}>
        <span className={styles.rowLabel}>เลขที่</span>
        <span className={styles.amount}>{data.receiptNumber ?? data.orderNumber}</span>
      </div>
      {data.receiptNumber ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>ออเดอร์</span>
          <span className={styles.amount}>{data.orderNumber}</span>
        </div>
      ) : null}
      <div className={styles.row}>
        <span className={styles.rowLabel}>วันที่</span>
        <span className={styles.amount}>
          {bangkokDayString(moment)} {bangkokTimeString(moment)}
        </span>
      </div>

      <hr className={styles.rule} />

      {data.lines.map((line) => (
        <div
          key={`${line.name}-${line.quantity}-${line.unitPrice}`}
          className={styles.row}
        >
          <span className={styles.rowLabel}>
            {line.name} × {line.quantity}
          </span>
          <span className={styles.amount}>{baht(line.totalPrice)}</span>
        </div>
      ))}

      <hr className={styles.rule} />

      <div className={styles.row}>
        <span className={styles.rowLabel}>รวม</span>
        <span className={styles.amount}>{baht(data.subtotalThb)}</span>
      </div>
      {data.discountThb > 0 ? (
        <div className={styles.row}>
          <span className={styles.rowLabel}>ส่วนลด</span>
          <span className={styles.amount}>-{baht(data.discountThb)}</span>
        </div>
      ) : null}

      {/*
        Only a VAT-registered sale shows the tax lines, and they are printed from the
        stored split — which is why they always add back up to the total.
      */}
      {data.isVatInvoice ? (
        <>
          <div className={`${styles.row} ${styles.small}`}>
            <span className={styles.rowLabel}>ยอดก่อน VAT</span>
            <span className={styles.amount}>{baht(data.netThb)}</span>
          </div>
          <div className={`${styles.row} ${styles.small}`}>
            <span className={styles.rowLabel}>{vatLabel(data.vatRatePercent ?? 0)}</span>
            <span className={styles.amount}>{baht(data.vatThb)}</span>
          </div>
        </>
      ) : null}

      <div className={`${styles.row} ${styles.grand}`}>
        <span className={styles.rowLabel}>ยอดชำระ</span>
        <span className={styles.amount}>{baht(data.finalAmountThb)}</span>
      </div>
      {/*
        One line per money leg. A single `รับเงิน 35.00` above a `เงินทอน 65.00`
        is a receipt that does not add up; printing what was actually handed over
        does, and a transfer is named as a transfer rather than as cash.
      */}
      {data.tenders.map((tender) => (
        <div key={tender.method} className={styles.row}>
          <span className={styles.rowLabel}>{tenderLabel(tender.method)}</span>
          <span className={styles.amount}>{baht(tenderedAmount(tender))}</span>
        </div>
      ))}
      <div className={`${styles.row} ${styles.totalRow}`}>
        <span className={styles.rowLabel}>เงินทอน</span>
        <span className={styles.amount}>{baht(data.changeThb)}</span>
      </div>

      {data.pointsRedeemed > 0 ? (
        <div className={`${styles.row} ${styles.small}`}>
          <span className={styles.rowLabel}>ใช้คะแนน</span>
          <span className={styles.amount}>{data.pointsRedeemed}</span>
        </div>
      ) : null}
      {data.pointsEarned > 0 ? (
        <p className={styles.foot}>ได้รับ {data.pointsEarned} คะแนน</p>
      ) : null}

      <p className={styles.foot}>{shop.receiptFooter?.trim() || 'ขอบคุณที่ใช้บริการ'}</p>
    </div>
  );
}
