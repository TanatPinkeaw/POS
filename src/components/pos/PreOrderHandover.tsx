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
import { handoverLookupBody } from '@/lib/pickup-scan';
import {
  PAYMENT_INTENT_STATUS_LABELS,
  type PaymentIntentView,
} from '@/lib/payment-intents-view';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

import { useOpenShift } from './useOpenShift';
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
  const [mode, setMode] = useState<TenderMode>('cash');
  const [cash, setCash] = useState('');
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
  const cashDue = mode === 'promptpay' ? afterPoints : Math.max(0, afterPoints - transferThb);
  const waitingForTransfer = intent !== null && intent.status === 'pending';

  // Reset per order, so reopening on a different order never shows the last one's draft.
  useEffect(() => {
    if (order === null) {
      return;
    }
    setMode('cash');
    setCash('');
    setReceivedCash('');
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
      setCash(String(cashDue));
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
          <>
            <Button variant="secondary" disabled={busy} onClick={() => void dropIntent()}>
              ยกเลิก QR
            </Button>
            <Button size="lg" icon="qr" loading disabled>
              รอเงินเข้า…
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
              disabled={shift === null}
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
                  setUsePoints(event.target.checked);
                  setCash('');
                  setSplitTransfer('');
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
                      ? 'ให้ลูกค้าสแกนที่จอนี้ — เมื่อเงินเข้าบิลจะปิดเอง'
                      : PAYMENT_INTENT_STATUS_LABELS[intent.status]}
                  </p>
                </>
              ) : (
                <>
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
              onChange={(event) => setSplitTransfer(event.target.value)}
              help="เงินสดเป็นขาสุดท้ายเสมอ เพื่อให้เงินทอนคำนวณจากส่วนที่จ่ายเป็นเงินสด"
            />
          ) : null}

          {mode === 'cash' ? (
            <div className={styles.cashRow}>
              <TextField
                id="handover-cash"
                label="เงินสดที่รับ (บาท)"
                inputMode="decimal"
                className="ln-num"
                value={cash}
                onChange={(event) => setCash(event.target.value)}
              />
              <TextField
                id="handover-received"
                label="ลูกค้ายื่นมา (บาท)"
                inputMode="decimal"
                className="ln-num"
                value={receivedCash}
                onChange={(event) => setReceivedCash(event.target.value)}
              />
            </div>
          ) : null}
        </div>
      )}
    </Overlay>
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