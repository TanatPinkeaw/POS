'use client';

import { Button, Icon, InlineNotice, Money, TextField } from '@/components/ds';
import { formatThb } from '@/lib/money';

import type { Till } from './useTill';
import styles from './Till.module.css';

/**
 * The bill: everything on the left of the till.
 *
 * Left, and not right, because that is the side the reference design puts the bill
 * on — copy the language, and the layout that language was drawn for comes with it.
 *
 * What is *not* copied is the bill's contents. Theirs is a restaurant bill with
 * covers, courses and a service charge; this one has a discount and a loyalty
 * balance and nothing else, because a grocery sale is one document with one total.
 */
export function TillBill({
  till,
  onPay,
  taxLabel,
}: {
  till: Till;
  onPay: () => void;
  /** e.g. "ราคารวม VAT 7%" — shown so the operator can answer the question. */
  taxLabel: string | null;
}) {
  const lineCount = till.lines.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <section className={styles.pane} aria-label="บิลปัจจุบัน">
      <div className={styles.paneHeader}>
        <span className={styles.paneTitle}>
          <Icon name="receipt" size={18} />
          บิลปัจจุบัน
          {lineCount > 0 ? (
            <span className={styles.tileStock}>({lineCount} ชิ้น)</span>
          ) : null}
        </span>
        {till.lines.length > 0 ? (
          <Button variant="text" size="sm" onClick={till.clearCart}>
            ล้างบิล
          </Button>
        ) : null}
      </div>

      <div className={styles.paneBody}>
        {till.lines.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="scan" size={28} />
            <p>สแกนบาร์โค้ดหรือเลือกสินค้าเพื่อเริ่มขาย</p>
          </div>
        ) : (
          <ul className={styles.billLines}>
            {till.lines.map((line) => (
              <li key={line.productId} className={styles.line}>
                <span>
                  <span className={styles.lineName}>{line.name}</span>
                  <span className={styles.lineUnit}>
                    {formatThb(line.unitPrice)} / ชิ้น
                  </span>
                </span>

                <span className={styles.stepper}>
                  <button
                    type="button"
                    className={styles.stepperButton}
                    aria-label={`ลดจำนวน ${line.name}`}
                    onClick={() => till.setQuantity(line.productId, line.quantity - 1)}
                  >
                    −
                  </button>
                  <span className={styles.stepperValue} aria-live="polite">
                    {line.quantity}
                  </span>
                  <button
                    type="button"
                    className={styles.stepperButton}
                    aria-label={`เพิ่มจำนวน ${line.name}`}
                    disabled={line.quantity >= line.availableQty}
                    onClick={() => till.setQuantity(line.productId, line.quantity + 1)}
                  >
                    +
                  </button>
                </span>

                <span className={styles.lineTotal}>
                  {formatThb(line.unitPrice * line.quantity)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* ------------------------------------------------------------------ */}
        <div style={{ marginTop: 'var(--ln-space-3)', display: 'grid', gap: 'var(--ln-space-3)' }}>
          <div>
            <div style={{ display: 'flex', gap: 'var(--ln-space-2)', alignItems: 'flex-end' }}>
              <div style={{ flex: 1 }}>
                <TextField
                  id="member"
                  label="สมาชิก (ไม่บังคับ)"
                  placeholder="เบอร์โทรสมาชิก"
                  inputMode="tel"
                  value={till.memberQuery}
                  onChange={(event) => till.setMemberQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void till.findMember();
                    }
                  }}
                />
              </div>
              <Button variant="secondary" onClick={() => void till.findMember()}>
                ค้นหา
              </Button>
            </div>

            {till.memberError ? <InlineNotice tone="danger">{till.memberError}</InlineNotice> : null}

            {till.member ? (
              <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>
                  {till.member.fullName} · {till.member.phone}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--ln-space-2)' }}>
                  <span className={styles.settingsValue}>
                    {till.member.pointsBalance.toLocaleString('en-US')} คะแนน
                  </span>
                  <Button
                    variant="text"
                    size="sm"
                    onClick={() => {
                      till.setMember(null);
                      till.setUsePoints(false);
                    }}
                  >
                    เอาออก
                  </Button>
                </span>
              </div>
            ) : null}

            {till.member && till.member.pointsBalance >= 100 ? (
              <div className={styles.settingsRow}>
                <label className={styles.settingsLabel} htmlFor="use-points">
                  ใช้คะแนน (100 คะแนน = 1 บาท)
                </label>
                <input
                  id="use-points"
                  type="checkbox"
                  checked={till.usePoints}
                  onChange={(event) => till.setUsePoints(event.target.checked)}
                  style={{ width: 20, height: 20 }}
                />
              </div>
            ) : null}
          </div>

          <TextField
            id="discount"
            label="ส่วนลด (บาท)"
            inputMode="decimal"
            value={till.discount}
            onChange={(event) => till.setDiscount(event.target.value)}
          />
        </div>
      </div>

      <div className={styles.billFooter}>
        <div className={styles.totals}>
          <div className={styles.totalRow}>
            <span className={styles.totalRowLabel}>ยอดรวม</span>
            <span className={styles.totalRowAmount}>
              <Money amount={till.subtotal} />
            </span>
          </div>
          {till.discountValue + till.pointsValue > 0 ? (
            <div className={styles.totalRow}>
              <span className={styles.totalRowLabel}>
                ส่วนลด{till.pointsValue > 0 ? ` (รวมคะแนน ${formatThb(till.pointsValue)})` : ''}
              </span>
              <span className={styles.totalRowAmount}>
                <Money amount={-(till.discountValue + till.pointsValue)} />
              </span>
            </div>
          ) : null}
          {taxLabel ? <p className={styles.hint}>{taxLabel}</p> : null}
          <div className={styles.totalDue}>
            <span>ยอดชำระ</span>
            <span className={styles.totalDueAmount}>{formatThb(till.due)}</span>
          </div>
        </div>

        {till.error ? <InlineNotice tone="danger">{till.error}</InlineNotice> : null}

        {/*
         * One button, full width, `lg` — the largest control on the screen. The tap
         * budget this interface is held to is three taps from the last scan to a
         * printed receipt, and this is the first of them.
         */}
        <Button
          size="lg"
          block
          icon="cash"
          disabled={till.lines.length === 0}
          onClick={onPay}
        >
          รับชำระเงิน · {formatThb(till.due)}
        </Button>
      </div>
    </section>
  );
}
