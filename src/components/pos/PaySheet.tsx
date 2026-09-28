'use client';

import { Button, Numpad, Overlay, QuickCash, Tabs } from '@/components/ds';
import { formatThb } from '@/lib/money';

import type { TenderMode, Till } from './useTill';
import styles from './Till.module.css';

/**
 * Taking the money.
 *
 * The reference design's cashier screen accepts several tenders at once — a
 * welfare coupon, a promotion, a card, and finally cash — and states the rule that
 * makes that safe: **cash is processed last, so the change is computed against the
 * cash share and not against the bill.** This application's settlement layer was
 * already built that way (`src/lib/settlement.ts` writes one payment row per leg
 * and derives change from `receivedCash − cash`), so this sheet is the first screen
 * to actually expose it: until now the till forced an either/or choice between
 * cash and PromptPay, which meant a customer paying 100 baht on a transfer and the
 * rest in notes could not be served correctly.
 *
 * The other thing worth stating: nothing here pretends to verify money. Their
 * system closes a bill when the bank confirms the transfer; this one is told by a
 * person and says so, rather than showing a scan animation over a payment it never
 * checked.
 */
export function PaySheet({
  till,
  open,
  onClose,
}: {
  till: Till;
  open: boolean;
  onClose: () => void;
}) {
  const modes = [
    { key: 'cash', label: 'เงินสด' },
    { key: 'promptpay', label: 'พร้อมเพย์' },
    { key: 'split', label: 'แบ่งจ่าย' },
  ];

  const appendDigit = (key: string): void => {
    till.setReceivedCash((current) => {
      if (key === '.' && current.includes('.')) {
        return current;
      }
      // One leading zero is dropped, so the display reads "500" and not "0500".
      const next = current === '0' && key !== '.' ? key : current + key;
      return next.length > 9 ? current : next;
    });
  };

  const short = till.receivedCash !== '' && till.change < 0;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      variant="sheet"
      title="รับชำระเงิน"
      description={`ยอดที่ต้องเก็บ ${formatThb(till.due)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={till.busy}>
            ยกเลิก
          </Button>
          <Button
            size="lg"
            icon="check"
            loading={till.busy}
            disabled={!till.canPay}
            onClick={() => void till.checkout()}
          >
            ยืนยันรับเงิน
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--ln-space-4)' }}>
        <Tabs
          label="วิธีชำระเงิน"
          variant="segmented"
          items={modes}
          value={till.tenderMode}
          onChange={(key) => {
            const mode = key as TenderMode;
            till.setTenderMode(mode);
            // Moving to cash puts the exact amount in the field: the most common
            // cash sale in a grocery is exact, and pre-filling removes the taps
            // that used to be spent typing it.
            till.setReceivedCash(mode === 'promptpay' ? '' : String(till.cashDue || ''));
          }}
        />

        {till.tenderMode === 'split' ? (
          <label style={{ display: 'grid', gap: 'var(--ln-space-2)' }}>
            <span className={styles.settingsLabel}>ยอดที่โอน (บาท)</span>
            <input
              className={styles.payAmount}
              inputMode="decimal"
              value={till.splitPromptpay}
              onChange={(event) => {
                till.setSplitPromptpay(event.target.value);
                const transfer = Math.max(0, Number(event.target.value || 0));
                till.setReceivedCash(String(Math.max(0, Math.round((till.due - transfer) * 100) / 100)));
              }}
            />
            <span className={styles.hint}>
              เงินสดเป็นขาสุดท้ายเสมอ เพื่อให้เงินทอนคำนวณจากส่วนที่จ่ายเป็นเงินสด
            </span>
          </label>
        ) : null}

        {till.tenderMode === 'promptpay' ? (
          <div className={styles.settingsRow}>
            <span className={styles.settingsLabel}>โอนเข้าพร้อมเพย์ร้าน</span>
            <span className={styles.settingsValue}>{formatThb(till.due)}</span>
          </div>
        ) : (
          <>
            <div>
              <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>เงินสดที่ต้องเก็บ</span>
                <span className={styles.settingsValue}>{formatThb(till.cashDue)}</span>
              </div>
              <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>
                  <label htmlFor="received">รับเงินมา (บาท)</label>
                </span>
                <span className={styles.settingsValue}>
                  {till.receivedCash === '' ? '—' : formatThb(Number(till.receivedCash))}
                </span>
              </div>
              <input id="received" className="ln-visually-hidden" value={till.receivedCash} readOnly />
            </div>

            <QuickCash
              onPick={(amount) => till.setReceivedCash(String(amount))}
              onExact={() => till.setReceivedCash(String(till.cashDue))}
            />

            <div
              className={`${styles.changeDue} ${till.change > 0 ? '' : styles.changeZero}`}
              role="status"
              aria-live="polite"
            >
              <span>{short ? 'ยังไม่พอ' : 'เงินทอน'}</span>
              <span>{short ? formatThb(Math.abs(till.change)) : formatThb(till.change)}</span>
            </div>

            <Numpad
              onInput={appendDigit}
              onBackspace={() => till.setReceivedCash((current) => current.slice(0, -1))}
              onClear={() => till.setReceivedCash('')}
            />
          </>
        )}
      </div>
    </Overlay>
  );
}
