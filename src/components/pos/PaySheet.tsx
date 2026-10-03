'use client';

import { Button, InlineNotice, Numpad, Overlay, QrPanel, QuickCash, Tabs } from '@/components/ds';
import { formatThb } from '@/lib/money';
import { PAYMENT_INTENT_STATUS_LABELS } from '@/lib/payment-intents-view';

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
  const deviceCashOnly = till.offline?.online === false || Boolean(till.offline?.snapshot?.heldBlocks.length || till.offline?.pending.count);
  const modes = [
    { key: 'cash', label: 'เงินสด' },
    { key: 'promptpay', label: 'พร้อมเพย์', disabled: deviceCashOnly },
    { key: 'split', label: 'แบ่งจ่าย', disabled: deviceCashOnly },
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

  /**
   * A live QR is on screen, so the money is in flight and the bill closes itself.
   *
   * The confirm button is disabled rather than hidden in this state: an operator
   * who cannot see the button they expect will press something else, and
   * "ยืนยันรับเงิน" on a bill nobody has confirmed receiving is the one mistake
   * this screen must not invite.
   */
  const waitingForTransfer = till.intent !== null && till.intent.status === 'pending';

  /**
   * Switches tender, and manages the QR that goes with it.
   *
   * Picking พร้อมเพย์ issues a code immediately: the customer needs it on their
   * own screen while the cashier is still finishing, and asking for a second tap
   * to "create" something that is about to be needed anyway is a tap spent for
   * nothing. Leaving the mode cancels it, because a live QR for a bill being paid
   * another way is a QR the next customer can pay.
   */
  const chooseMode = (mode: TenderMode): void => {
    till.setTenderMode(mode);
    till.setReceivedCash(mode === 'promptpay' ? '' : String(till.cashDue || ''));

    if (mode === 'promptpay' && till.intent === null) {
      void till.startIntent();
    }
    if (mode !== 'promptpay' && till.intent !== null) {
      void till.dropIntent();
    }
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      variant="sheet"
      size="lg"
      title="รับชำระเงิน"
      description={`ยอดที่ต้องเก็บ ${formatThb(till.due)}`}
      footer={
        waitingForTransfer ? (
          <>
            <Button
              variant="secondary"
              disabled={till.busy}
              onClick={() => void till.dropIntent()}
            >
              ยกเลิก QR
            </Button>
            <Button size="lg" icon="qr" loading disabled>
              รอเงินเข้า…
            </Button>
          </>
        ) : (
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
        )
      }
    >
      <div style={{ display: 'grid', gap: 'var(--ln-space-4)' }}>
        {till.error ? <InlineNotice tone="danger">{till.error}</InlineNotice> : null}
        {/*
          Said inside the sheet, not just on the page behind it: a cashier who cannot take
          the money is looking here. This is the never-silent half of a button that stays
          visible and disabled rather than disappearing.
        */}
        {!waitingForTransfer && till.payBlockedReason ? (
          <InlineNotice tone="warning">{till.payBlockedReason}</InlineNotice>
        ) : null}
        {deviceCashOnly ? <InlineNotice tone="warning">รับเฉพาะเงินสดไม่ผูกสมาชิก — ส่งบิลและคืนชุดเลขก่อนใช้พร้อมเพย์ สมาชิก หรือแต้ม</InlineNotice> : null}
        <Tabs
          label="วิธีชำระเงิน"
          variant="segmented"
          items={modes}
          value={till.tenderMode}
          /*
           * Moving to cash puts the exact amount in the field: the most common
           * cash sale in a grocery is exact, and pre-filling removes the taps that
           * used to be spent typing it.
           */
          onChange={(key) => chooseMode(key as TenderMode)}
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
          <div className={styles.qrArea}>
            {till.intent ? (
              <>
                <QrPanel intent={till.intent} size={200} />
                <p className={styles.hint}>
                  {till.intent.status === 'pending'
                    ? 'ให้ลูกค้าสแกนที่จอนี้หรือที่จอลูกค้า — เมื่อเงินเข้าบิลจะปิดเอง'
                    : PAYMENT_INTENT_STATUS_LABELS[till.intent.status]}
                </p>
              </>
            ) : (
              <>
                <div className={styles.settingsRow}>
                  <span className={styles.settingsLabel}>โอนเข้าพร้อมเพย์ร้าน</span>
                  <span className={styles.settingsValue}>{formatThb(till.due)}</span>
                </div>
                <Button
                  icon="qr"
                  loading={till.intentBusy}
                  onClick={() => void till.startIntent()}
                >
                  ออก QR พร้อมเพย์
                </Button>
                {till.intentError ? (
                  <p className={styles.hint} role="alert">
                    {till.intentError}
                  </p>
                ) : null}
                <p className={styles.hint}>
                  ถ้ายังไม่ได้ตั้งพร้อมเพย์ของร้าน จะออก QR ไม่ได้ — ยืนยันรับเงินสดแทนได้เลย
                </p>
              </>
            )}
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
