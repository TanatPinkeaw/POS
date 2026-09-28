/**
 * The credit note (ADR 0004).
 *
 * The second half of a document pair, and it is deliberately the same shape as
 * `Receipt`: same sheet, same typography, same `ln-receipt-sheet` print rules, so
 * that a customer holding both can see at a glance that one reverses the other.
 * The differences are all statements of fact — a different series, the reason the
 * money went back, and a reference to the invoice being reversed.
 *
 * It renders from the credit note's *own* snapshot: its number, its tax split and
 * its rate come from the document, not from the sale and not from the shop's
 * current settings. If the VAT rate ever changes, reprinting a 2026 credit note
 * must still show what was reversed in 2026 — the same rule the receipt carries,
 * and the reason both documents copy the rate onto themselves rather than
 * joining to it.
 *
 * Handing the money back is *not* printed as though the original tender were
 * reversed, because it usually is not: the customer paid by transfer and took
 * cash, or the other way round. The original tenders are restated under `บิลเดิม`
 * so the paper trail is complete, and the line that says how the money came back
 * comes from the credit note itself.
 */
import { bangkokDayString, bangkokTimeString } from '@/lib/bangkok-time';
import type { CreditNoteDocument } from '@/lib/credit-note-view';
import type { ShopView } from '@/lib/shop-view';
import { vatLabel } from '@/lib/shop-view';
import { tenderedAmount, tenderLabel } from '@/lib/tender';

import styles from './Receipt.module.css';

const baht = (amount: number): string => amount.toFixed(2);

export function CreditNote({ shop, data }: { shop: ShopView; data: CreditNoteDocument }) {
  const issued = new Date(data.issuedAt);
  const sold = new Date(data.original.soldAt);

  /*
   * The document's name is a legal statement, exactly as it is on a receipt: a
   * VAT-registered shop issues a credit note against an invoice, and a shop that
   * is not must not claim to. The reference to the original number is what makes
   * the pair auditable.
   */
  const title = data.isVatInvoice ? 'ใบลดหนี้ (อ้างอิงใบกำกับภาษี)' : 'ใบลดหนี้';

  return (
    <div className={`${styles.receipt} ln-receipt-sheet`} data-testid="credit-note">
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

      <div className={styles.row}>
        <span className={styles.rowLabel}>เลขที่</span>
        <span className={styles.amount}>{data.documentNumber}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>วันที่</span>
        <span className={styles.amount}>
          {bangkokDayString(issued)} {bangkokTimeString(issued)}
        </span>
      </div>

      {/*
        The original document, which is the thing an accountant looks for first.
        A receipt number when there is one, otherwise the order the sale was
        recorded under — a shop that is not VAT-registered never issued an invoice
        number, and printing a blank there would look like a gap rather than a fact.
      */}
      <div className={styles.row}>
        <span className={styles.rowLabel}>อ้างอิงบิลเดิม</span>
        <span className={styles.amount}>
          {data.original.receiptNumber ?? data.original.orderNumber}
        </span>
      </div>
      {data.original.receiptNumber ? (
        <div className={`${styles.row} ${styles.small}`}>
          <span className={styles.rowLabel}>ออเดอร์</span>
          <span className={styles.amount}>{data.original.orderNumber}</span>
        </div>
      ) : null}
      <div className={`${styles.row} ${styles.small}`}>
        <span className={styles.rowLabel}>ขายเมื่อ</span>
        <span className={styles.amount}>
          {bangkokDayString(sold)} {bangkokTimeString(sold)}
        </span>
      </div>

      <hr className={styles.rule} />

      {data.original.lines.map((line) => (
        <div key={`${line.name}-${line.quantity}-${line.unitPrice}`} className={styles.row}>
          <span className={styles.rowLabel}>
            {line.name} × {line.quantity}
          </span>
          <span className={styles.amount}>{baht(line.totalPrice)}</span>
        </div>
      ))}

      <hr className={styles.rule} />

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
        <span className={styles.rowLabel}>ยอดคืนเงิน</span>
        <span className={styles.amount}>{baht(data.finalAmountThb)}</span>
      </div>

      <hr className={styles.rule} />

      <div className={styles.row}>
        <span className={styles.rowLabel}>วิธีคืนเงิน</span>
        <span className={styles.amount}>{data.refundMethodLabel}</span>
      </div>

      {/*
        What the customer originally paid, restated. Deliberately *not* labelled as
        what was reversed: the money usually came back a different way, and a
        document that implied a bank had returned a transfer it never made is worse
        than one that simply records both facts.
      */}
      {data.original.tenders.map((tender) => (
        <div key={tender.method} className={`${styles.row} ${styles.small}`}>
          <span className={styles.rowLabel}>บิลเดิม · {tenderLabel(tender.method)}</span>
          <span className={styles.amount}>{baht(tenderedAmount(tender))}</span>
        </div>
      ))}

      {data.pointsClawedBack > 0 || data.pointsForgiven > 0 ? (
        <>
          <div className={`${styles.row} ${styles.small}`}>
            <span className={styles.rowLabel}>ยึดคืนคะแนนที่ให้ไป</span>
            <span className={styles.amount}>{data.pointsClawedBack}</span>
          </div>
          {/*
            Stated rather than hidden: a customer who already spent the points they
            earned cannot cover the clawback, and a refund must not depend on their
            balance. Saying so here is what stops the difference becoming a mystery
            in a report nobody can explain six months later.
          */}
          {data.pointsForgiven > 0 ? (
            <div className={`${styles.row} ${styles.small}`}>
              <span className={styles.rowLabel}>คะแนนที่ยึดคืนไม่ได้ (ใช้ไปแล้ว)</span>
              <span className={styles.amount}>{data.pointsForgiven}</span>
            </div>
          ) : null}
        </>
      ) : null}

      <div className={styles.row}>
        <span className={styles.rowLabel}>เหตุผล</span>
        <span className={styles.amount}>{data.reason}</span>
      </div>
      <div className={`${styles.row} ${styles.small}`}>
        <span className={styles.rowLabel}>ผู้ออกเอกสาร</span>
        <span className={styles.amount}>{data.issuedBy}</span>
      </div>
      {data.approvedBy ? (
        <div className={`${styles.row} ${styles.small}`}>
          <span className={styles.rowLabel}>ผู้อนุมัติ</span>
          <span className={styles.amount}>{data.approvedBy}</span>
        </div>
      ) : null}

      <p className={styles.foot}>เอกสารนี้ใช้คู่กับใบเสร็จฉบับเดิม</p>
    </div>
  );
}
