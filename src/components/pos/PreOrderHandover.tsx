'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Button,
  DataTable,
  InlineNotice,
  Money,
  Overlay,
  QrPanel,
  Tabs,
  TextField,
  Thumb,
  type Column,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import { formatThb } from '@/lib/money';
import { handoverLookupBody } from '@/lib/pickup-scan';
import {
  PAYMENT_INTENT_STATUS_LABELS,
  type PaymentIntentView,
} from '@/lib/payment-intents-view';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import { APPROVAL_HEADER } from '@/lib/supervisor-view';

import { useOpenShift } from './useOpenShift';
import { SupervisorApprovalDialog } from './SupervisorApprovalDialog';
import { useSupervisorApproval } from './useSupervisorApproval';
import styles from './PreOrderHandover.module.css';

/** The order as the handover needs it — a subset of what `/api/v1/orders/[id]` returns. */
export interface HandoverOrder {
  id: string;
  orderNumber: string;
  status: string;
  finalAmountThb: number;
  pickupPin: string | null;
  customer: { id: string; fullName: string; phone: string; pointsBalance: number } | null;
  items: {
    id: string;
    productId: string;
    name: string;
    imageUrl: string | null;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }[];
}

export interface HandoverResult {
  orderId: string;
  orderNumber: string;
  changeThb: number;
  paidThb: number;
}

type TenderMode = 'cash' | 'promptpay' | 'split';

/**
 * Receiving a pre-order and taking the money for it — SRS §3 Phase 4.
 *
 * **Why this is its own component and not a dialog inside `PreOrderBoard`.** It has
 * two callers now. The board is where an order is picked up when the shop is looking
 * at the board, but the till at `/pos` is where the cashier actually stands, and a
 * customer who walked in holding a collection QR should not have to be walked to
 * another screen to be paid — they get scanned straight into this dialog from the
 * search box the till already has. The board was where scanning a pre-order lived
 * before, which meant "can I take money for this order" was answered "yes, but go to
 * the other tab first".
 *
 * **It owns its own PromptPay intent rather than sharing the till's.** The till's
 * intent is entangled with the cart it settles (`settlePaidIntent` calls the cart's
 * `checkout`), so reusing that hook here would mean standing up a second cart. The
 * duplication is about forty lines against a payment intent POST, and the alternative
 * is a hook that has to know which of two unrelated sales it is about to close.
 *
 * Points, cash, transfer and a split of the last two are all offered, because the
 * money rules for a pre-order are the money rules for a walk-in sale (`buildSettlement`
 * is shared) and a shop that takes transfers should not have to close one at the
 * counter in cash to get a customer through the door.
 */
export function PreOrderHandover({
  order,
  open,
  onClose,
  onCompleted,
}: {
  /** Null closes the dialog without rendering anything. */
  order: HandoverOrder | null;
  open: boolean;
  onClose: () => void;
  onCompleted: (result: HandoverResult) => void;
}) {
  const { shift } = useOpenShift();
  /*
   * The handover asks for a supervisor's PIN itself, rather than being handed a
   * callback the way the till is: it has two callers on two pages and neither of
   * them owns an approval for anything else, and `RefundDialog` already set the
   * precedent of a dialog carrying its own.
   */
  const approval = useSupervisorApproval();
  const [mode, setMode] = useState<TenderMode>('cash');
  const [receivedCash, setReceivedCash] = useState('');
  const [splitTransfer, setSplitTransfer] = useState('');
  const [usePoints, setUsePoints] = useState(false);
  const [intent, setIntent] = useState<PaymentIntentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [intentBusy, setIntentBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * The reference of an intent already settled against this order. The socket can
   * report the same payment twice — a reconnect replays, and the till polls as well
   * as listening — and without this the second delivery would post a second
   * `/complete`, which fails on the state machine but only after showing an error
   * to a customer whose goods they already have.
   */
  const consumedRef = useRef<string | null>(null);

  const due = order?.finalAmountThb ?? 0;
  const pointsThb =
    usePoints && order?.customer ? Math.floor(order.customer.pointsBalance / 100) * 100 : 0;
  const afterPoints = Math.max(0, Math.round((due - pointsThb) * 100) / 100);
  const transferThb = Math.max(0, Number(splitTransfer || 0));
  /**
   * The cash leg of this payment, which is the whole amount unless the cashier is
   * splitting it. Kept apart from `cashDue` so the handlers that refill the received
   * field do not depend on the tab the cashier is *leaving* — `chooseMode` reads these
   * values before `setMode` has taken effect.
   */
  const cashPortionThb = Math.max(0, Math.round((afterPoints - transferThb) * 100) / 100);
  const cashDue = mode === 'promptpay' ? afterPoints : cashPortionThb;
  const received = Number(receivedCash || 0);
  const changeThb = Math.round((received - cashDue) * 100) / 100;
  /** A note smaller than the bill. The server refuses the sale for this; showing it here is the same rule, earlier. */
  const short = mode !== 'promptpay' && receivedCash.trim() !== '' && changeThb < 0;
  const waitingForTransfer = intent !== null && intent.status === 'pending';

  // Reset per order, so reopening on a different order never shows the last one's draft.
  useEffect(() => {
    if (order === null) {
      return;
    }
    setMode('cash');
    /*
     * The amount is in the field before the cashier has touched anything.
     *
     * A handover is scanned, the dialog opens, and the common case is the exact note —
     * `PaySheet` says the same of a walk-in sale, and prefilling is what removed the
     * taps. It also answers the complaint that the money "did not come up": an empty
     * field next to a total is a field the cashier has to read the total off the screen
     * and type back before they can press anything.
     */
    setReceivedCash(String(Math.round((order.finalAmountThb ?? 0) * 100) / 100));
    setSplitTransfer('');
    setUsePoints(false);
    setIntent(null);
    setError(null);
    consumedRef.current = null;
  }, [order?.id]);

  /** Cancels a live QR, so its reference can never be paid by the next customer. */
  const dropIntent = useCallback(async (): Promise<void> => {
    const current = intent;
    setIntent(null);
    if (current === null || current.status !== 'pending') {
      return;
    }
    // Best effort: an uncancellable code still expires on its own, and a customer
    // standing at the counter should not wait on housekeeping.
    try {
      await apiPost(`/api/v1/payments/intents/${current.ref}/cancel`, {});
    } catch {
      // Deliberately ignored. See above.
    }
  }, [intent]);

  const startIntent = useCallback(
    async (amountThb: number): Promise<void> => {
      if (shift === null) {
        setError('ต้องเปิดลิ้นชักก่อนออก QR');
        return;
      }
      setIntentBusy(true);
      setError(null);
      try {
        const created = await apiPost<PaymentIntentView>('/api/v1/payments/intents', {
          shiftId: shift.id,
          amountThb: Math.round(amountThb * 100) / 100,
        });
        setIntent(created);
      } catch (caught) {
        setError(
          caught instanceof ApiError ? caught.message : 'ออก QR พร้อมเพย์ไม่สำเร็จ',
        );
      } finally {
        setIntentBusy(false);
      }
    },
    [shift],
  );

  /**
   * Choosing พร้อมเพย์ issues the code immediately, and leaving it cancels.
   *
   * The same rule the till follows, for the same reason: the customer needs the QR
   * while the cashier is still finishing, and a live code left on screen for a bill
   * being paid in cash is a code the next customer can pay.
   */
  const chooseMode = (next: TenderMode): void => {
    setMode(next);
    setError(null);
    if (next === 'promptpay' && intent === null) {
      void startIntent(afterPoints);
    }
    if (next === 'cash') {
      setReceivedCash(String(cashPortionThb));
      void dropIntent();
    }
    if (next === 'split') {
      void dropIntent();
    }
  };

  const finish = useCallback(
    async (intentRef?: string): Promise<void> => {
      if (order === null) {
        return;
      }
      if (intentRef !== undefined && consumedRef.current === intentRef) {
        return;
      }
      if (intentRef !== undefined) {
        consumedRef.current = intentRef;
      }
      if (shift === null) {
        setError('ต้องเปิดลิ้นชักก่อนรับชำระเงิน');
        return;
      }

      const cashHanded = mode === 'promptpay' ? 0 : cashDue;
      setBusy(true);
      setError(null);
      try {
        const result = await apiPost<HandoverResult>(`/api/v1/orders/${order.id}/complete`, {
          shiftId: shift.id,
          settlement: {
            points: pointsThb,
            cash: Math.round(cashHanded * 100) / 100,
            promptpay:
              mode === 'promptpay'
                ? Math.round(afterPoints * 100) / 100
                : Math.round(transferThb * 100) / 100,
            receivedCash: Math.round(Number(receivedCash || cashHanded || 0) * 100) / 100,
          },
          ...(intentRef ? { intentRef } : {}),
        });
        setIntent(null);
        onCompleted(result);
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'ปิดการขายไม่สำเร็จ');
      } finally {
        setBusy(false);
      }
    },
    [order, shift, mode, cashDue, afterPoints, transferThb, pointsThb, receivedCash, onCompleted],
  );

  /*
   * The money arrived. A socket event is fast and the poll is reliable, and a till
   * that trusted only one of them stops settling transfers the moment the shop's wifi
   * blinks — so both paths end here and the guard above makes the second one a no-op.
   */
  const onPaid = useCallback(
    (paid: PaymentIntentView): void => {
      if (intent === null || paid.ref !== intent.ref || paid.status !== 'paid') {
        return;
      }
      void finish(paid.ref);
    },
    [intent, finish],
  );
  useRealtimeEvent(REALTIME_EVENTS.paymentPaid, onPaid);

  useEffect(() => {
    if (intent === null || intent.status !== 'pending') {
      return;
    }
    const timer = window.setInterval(() => {
      void apiFetch<PaymentIntentView>(`/api/v1/payments/intents/${intent.ref}`)
        .then((latest) => {
          if (latest.status === 'paid') {
            void finish(latest.ref);
          } else {
            setIntent(latest);
          }
        })
        .catch(() => {
          // A failed poll is not a failed payment; the next tick tries again.
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [intent, finish]);

  /**
   * A fresh QR for the same amount, replacing the one on screen.
   *
   * The same reasoning as the till's `refreshIntent`, and for the same reason: the
   * three ways a PromptPay code dies are all about time — it expires, the customer's
   * banking app refuses an old code, and a customer who closed their app and came
   * back finds a dead code and a cashier with no way to move them on. Redrawing the
   * same payload would fix the look of none of it, because the countdown is derived
   * from the intent's own expiry.
   */
  const refreshIntent = useCallback(async (): Promise<void> => {
    setIntentBusy(true);
    setError(null);
    try {
      const current = intent;
      if (current !== null && current.status === 'pending') {
        try {
          await apiPost(`/api/v1/payments/intents/${current.ref}/cancel`, {});
        } catch {
          // An old code that refuses to cancel expires on its own, and holding the
          // cashier up to make sure of it is the worse trade.
        }
      }
      setIntent(null);
      consumedRef.current = null;
      const created = await apiPost<PaymentIntentView>('/api/v1/payments/intents', {
        shiftId: shift?.id ?? 0,
        amountThb: Math.round(afterPoints * 100) / 100,
      });
      setIntent(created);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ออก QR ใหม่ไม่สำเร็จ');
    } finally {
      setIntentBusy(false);
    }
  }, [afterPoints, intent, shift]);

  /**
   * The cashier says the money arrived, and a supervisor agrees.
   *
   * This is the whole point of the till having the same two buttons: a shop with no
   * bank notification bridge never receives the event that closes the bill, so the
   * dialog used to sit on "รอเงินเข้า…" with nothing to press — the only thing the
   * counter could do was walk the customer away and leave the parcel unclaimed. The
   * server already had the endpoint and the audit action; this only gives the
   * handover the button that reaches them.
   *
   * **`/confirm`, not the bare reference.** The two routes are neighbours and only
   * one of them takes a POST: `intents/[ref]` is the read the poll uses, and posting
   * to it is a 405 from Next before any of this code runs. The console showed a shop
   * pressing this button and being told nothing had happened.
   *
   * The approval is bound to the intent's reference, so a supervisor who approved one
   * transfer cannot have that approval spent on a different bill, and `finish`'s
   * `consumedRef` guard keeps the socket and the button from closing it twice.
   */
  const confirmTransferManually = useCallback(async (): Promise<void> => {
    const current = intent;
    if (current === null || current.status !== 'pending') {
      return;
    }
    const token = await approval.request({
      action: 'manual_payment_confirm',
      targetId: current.ref,
      summary: `ยืนยันว่าโอนแล้ว ${formatThb(current.amountThb)} · รหัสอ้างอิง ${current.ref}`,
    });
    if (token === null) {
      // The supervisor walked away, which is a refusal rather than a failure.
      return;
    }

    setIntentBusy(true);
    setError(null);
    try {
      const confirmed = await apiFetch<PaymentIntentView>(
        `/api/v1/payments/intents/${current.ref}/confirm`,
        { method: 'POST', headers: { [APPROVAL_HEADER]: token } },
      );
      if (confirmed.status !== 'paid' && confirmed.status !== 'consumed') {
        setError('ยังยืนยันไม่ได้ — รหัสอ้างอิงนี้อาจหมดอายุแล้ว ลองออก QR ใหม่');
        return;
      }
      setIntent(null);
      void finish(confirmed.ref);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ยืนยันการโอนไม่สำเร็จ');
    } finally {
      setIntentBusy(false);
    }
  }, [approval, intent, finish]);

  const lineColumns: Column<HandoverOrder['items'][number]>[] = [
    {
      key: 'item',
      header: 'สินค้า',
      cardLabel: 'สินค้า',
      render: (item) => (
        <span className="ln-row">
          <Thumb url={item.imageUrl} size="sm" />
          <span className={styles.itemName}>
            {item.name} × {item.quantity}
          </span>
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'ยอด',
      cardLabel: 'ยอด',
      align: 'end',
      render: (item) => <Money amount={item.totalPrice} />,
    },
  ];

  return (
    <>
      <Overlay
        open={open && order !== null}
        onClose={onClose}
        size="lg"
        title={order ? `รับสินค้า ${order.orderNumber}` : ''}
        description={
          order
            ? `${order.customer ? `สมาชิก ${order.customer.fullName}` : 'ลูกค้าทั่วไป'}${
                order.pickupPin ? ` · PIN ${order.pickupPin}` : ''
              }`
            : ''
        }
        footer={
          waitingForTransfer ? (
            /*
             * The same three buttons the till offers, because a counter that takes
             * walk-in money and a counter that hands over a parcel are the same pair of
             * hands: confirm by hand once the money is in the banking app, replace a
             * code that died, or abandon the transfer.
             */
            <>
              <Button variant="secondary" disabled={busy} onClick={() => void dropIntent()}>
                ยกเลิก QR
              </Button>
              <Button
                variant="secondary"
                icon="refresh"
                loading={intentBusy}
                disabled={busy}
                onClick={() => void refreshIntent()}
              >
                ออก QR ใหม่
              </Button>
              <Button
                variant="primary"
                icon="check"
                loading={intentBusy}
                disabled={busy}
                onClick={() => void confirmTransferManually()}
              >
                ยืนยันว่าโอนแล้ว
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                ปิด
              </Button>
              <Button
                variant="success"
                icon="check"
                loading={busy}
                disabled={shift === null || short}
                onClick={() => void finish()}
              >
                ยืนยันการชำระเงิน
              </Button>
            </>
          )
        }
      >
        {order === null ? null : (
          <div className={styles.body}>
            {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
            {shift === null ? (
              <InlineNotice tone="warning">ต้องเปิดลิ้นชักก่อน จึงจะรับชำระเงินได้</InlineNotice>
            ) : null}

            <DataTable
              columns={lineColumns}
              rows={order.items}
              getRowKey={(item) => item.id}
              caption="รายการสินค้าในพรีออเดอร์นี้"
              dense
            />

            <div className={styles.total}>
              <span>ยอดที่ต้องชำระ</span>
              <Money amount={due} size="lg" />
            </div>

            {order.customer && order.customer.pointsBalance >= 100 ? (
              <label className={styles.pick}>
                <input
                  type="checkbox"
                  checked={usePoints}
                  onChange={(event) => {
                    // The cash figure moved, so the note moves with it — the same refill
                    // the till does when the split amount is typed.
                    const redeemable = Math.floor((order.customer?.pointsBalance ?? 0) / 100) * 100;
                    const spent = event.target.checked ? redeemable : 0;
                    setUsePoints(spent > 0);
                    setSplitTransfer('');
                    setReceivedCash(String(Math.max(0, Math.round((due - spent) * 100) / 100)));
                  }}
                />
                <span>
                  ใช้คะแนน {order.customer.pointsBalance} คะแนน ของ {order.customer.fullName} (ลดได้{' '}
                  {Math.floor(order.customer.pointsBalance / 100) * 100} บาท)
                </span>
              </label>
            ) : null}

            <Tabs
              label="วิธีชำระเงิน"
              variant="segmented"
              value={mode}
              items={[
                { key: 'cash', label: 'เงินสด' },
                { key: 'promptpay', label: 'พร้อมเพย์' },
                { key: 'split', label: 'แบ่งจ่าย' },
              ]}
              onChange={(key) => chooseMode(key as TenderMode)}
            />

            {mode === 'promptpay' ? (
              <div className={styles.qr}>
                {intent ? (
                  <>
                    <QrPanel intent={intent} size={200} />
                    <p className={styles.hint}>
                      {intent.status === 'pending'
                        ? 'ให้ลูกค้าสแกนที่จอนี้ — เงินเข้าบิลจะปิดเอง ถ้าเงินเข้าแล้วแต่ระบบยังไม่แจ้ง กดยืนยันว่าโอนแล้วได้เลย'
                        : PAYMENT_INTENT_STATUS_LABELS[intent.status]}
                    </p>
                  </>
                ) : (
                  <>
                    {/* The amount the customer is about to be asked for, said before the code. */}
                    <div className={styles.cashRow}>
                      <span className={styles.cashLabel}>โอนเข้าพร้อมเพย์ร้าน</span>
                      <Money amount={afterPoints} />
                    </div>
                    <Button icon="qr" loading={intentBusy} onClick={() => void startIntent(afterPoints)}>
                      ออก QR พร้อมเพย์
                    </Button>
                    <p className={styles.hint}>
                      ถ้ายังไม่ได้ตั้งพร้อมเพย์ของร้าน จะออก QR ไม่ได้ — ยืนยันรับเงินสดแทนได้เลย
                    </p>
                  </>
                )}
              </div>
            ) : null}

            {mode === 'split' ? (
              <TextField
                id="handover-split"
                label="ยอดที่โอน (บาท)"
                inputMode="decimal"
                className="ln-num"
                value={splitTransfer}
                onChange={(event) => {
                  setSplitTransfer(event.target.value);
                  const transfer = Math.max(0, Number(event.target.value || 0));
                  setReceivedCash(String(Math.max(0, Math.round((afterPoints - transfer) * 100) / 100)));
                }}
                help="เงินสดเป็นขาสุดท้ายเสมอ เพื่อให้เงินทอนคำนวณจากส่วนที่จ่ายเป็นเงินสด"
              />
            ) : null}

            {mode === 'cash' ? (
              /*
               * The till's three money rows, in the till's words: what to keep, what was
               * handed over, and the change that follows. This dialog used to show two
               * fields side by side — "cash received" and "handed by the customer" — and
               * the first one was wired to nothing at all: it was sent nowhere, so typing
               * in it changed the sale by exactly zero. A figure and a field is what a
               * cashier can read at a glance, and it is the same shape as `PaySheet`.
               */
              <div className={styles.cash}>
                <div className={styles.cashRow}>
                  <span className={styles.cashLabel}>เงินสดที่ต้องเก็บ</span>
                  <Money amount={cashDue} />
                </div>
                <TextField
                  id="handover-received"
                  label="รับเงินมา (บาท)"
                  inputMode="decimal"
                  className="ln-num"
                  value={receivedCash}
                  onChange={(event) => setReceivedCash(event.target.value)}
                />
                <div
                  className={`${styles.change} ${
                    short ? styles.changeShort : changeThb > 0 ? '' : styles.changeZero
                  }`}
                  role="status"
                  aria-live="polite"
                >
                  <span>{short ? 'ยังไม่พอ' : 'เงินทอน'}</span>
                  <Money amount={Math.abs(changeThb)} />
                </div>
              </div>
            ) : null}
          </div>
        )}
      </Overlay>

      {/*
       * Rendered after the handover so it paints over it: the supervisor is asked
       * about a transfer this dialog raised, and the PIN question has to be the
       * thing seen next rather than a dialog hidden behind this one. A sibling and
       * not a child of the overlay, because an overlay's scrim makes its fixed
       * descendants position against itself rather than the viewport.
       */}
      {approval.pending ? (
        <SupervisorApprovalDialog
          open
          action={approval.pending.action}
          targetId={approval.pending.targetId}
          {...(approval.pending.summary === undefined
            ? {}
            : { summary: approval.pending.summary })}
          onCancel={() => approval.pending?.settle(null)}
          onApproved={(grant) => approval.pending?.settle(grant)}
        />
      ) : null}
    </>
  );
}

/**
 * Opens the handover for whatever a scanned or typed term resolves to.
 *
 * The term is turned into a request body by `handoverLookupBody` rather than by
 * anything written here, so the bar's QR, a PIN read aloud and a phone number all
 * reach the one lookup route that knows how to tell them apart — the board and the
 * till cannot disagree about what a scan means.
 */
export function lookupHandoverOrder(term: string): Promise<HandoverOrder> {
  return apiPost<HandoverOrder>('/api/v1/orders/lookup', handoverLookupBody(term));
}