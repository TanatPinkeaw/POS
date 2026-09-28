'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  InlineNotice,
  Money,
  Pill,
  QrCode,
  Spinner,
  Stack,
  StatusPill,
} from '@/components/ds';

import styles from './MyOrders.module.css';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

interface OrderRow {
  id: string;
  orderNumber: string;
  status: 'pending' | 'confirmed' | 'ready_for_pickup' | 'completed' | 'cancelled';
  finalAmountThb: number;
  itemCount: number;
  pickupPin: string | null;
  /** The signed handover code behind the QR — see `src/lib/pickup-token.ts`. */
  pickupToken: string | null;
  createdAt: string;
  readyAt: string | null;
}

const STEPS = ['pending', 'confirmed', 'ready_for_pickup', 'completed'] as const;

const STEP_LABEL: Record<string, string> = {
  pending: 'รอยืนยัน',
  confirmed: 'กำลังเตรียม',
  ready_for_pickup: 'พร้อมรับ',
  completed: 'รับแล้ว',
  cancelled: 'ยกเลิก',
};

/**
 * The four phases, as chips.
 *
 * The chips carry the states the order has *passed* as well as the one it is in,
 * because the customer's question is never "what phase is it" — it is "how much
 * longer". A reached phase gets a tick; the current one is the only solid chip on
 * the screen. A cancelled order shows no stepper at all: a progress bar that has
 * stopped forever tells the customer nothing.
 */
function Stepper({ status }: { status: OrderRow['status'] }) {
  const current = STEPS.indexOf(status as (typeof STEPS)[number]);

  return (
    <div className="ln-row">
      {STEPS.map((step, index) => {
        const reached = index <= current;
        return (
          <Pill
            key={step}
            tone={index === current ? 'brand' : reached ? 'success' : 'neutral'}
            solid={index === current}
            icon={reached ? 'check' : undefined}
          >
            {STEP_LABEL[step]}
          </Pill>
        );
      })}
    </div>
  );
}

/**
 * The member's own order list — SRS §2.
 *
 * The handover credentials appear the moment staff pack the order: a QR to hold
 * up and be scanned (SRS §3), and the PIN underneath it for the phone whose screen
 * has died or whose battery is at 2%. It refreshes on realtime events rather than
 * polling, so "พร้อมรับ" appears on the customer's phone the instant the shelf
 * staff tag the bag.
 *
 * Cancelling asks first. It releases reserved stock and cannot be undone, and the
 * customer is the one person who cannot be asked to fix it at the counter — which
 * is the whole reason `ConfirmDialog` exists rather than a plain button.
 */
export function MyOrders() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<OrderRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows = await apiFetch<OrderRow[]>('/api/v1/orders?limit=50');
      setOrders(rows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'โหลดออเดอร์ไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtimeEvent(REALTIME_EVENTS.orderUpdated, useCallback(() => void load(), [load]));
  useRealtimeEvent(REALTIME_EVENTS.pointsUpdated, useCallback(() => void load(), [load]));

  async function cancel(order: OrderRow): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await apiPost(`/api/v1/orders/${order.id}/cancel`, { reason: 'ลูกค้ายกเลิกเอง' });
      setCancelling(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ยกเลิกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <Spinner />;
  }

  return (
    <Stack gap="md">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {orders.length === 0 ? (
        <Card>
          <EmptyState
            icon="receipt"
            title="ยังไม่มีออเดอร์"
            description="เลือกสินค้าและกดจองเพื่อเริ่มต้น"
          />
        </Card>
      ) : (
        orders.map((order) => (
          <Card
            key={order.id}
            title={<span className="ln-mono">{order.orderNumber}</span>}
            subtitle={`${order.itemCount} รายการ · ${new Date(order.createdAt).toLocaleString('th-TH')}`}
            actions={
              <>
                <StatusPill status={order.status} label={STEP_LABEL[order.status] ?? order.status} />
                <Money amount={order.finalAmountThb} size="lg" />
              </>
            }
          >
            <Stack gap="md">
              {order.status === 'cancelled' ? (
                <p className="ln-muted">
                  ออเดอร์นี้ถูกยกเลิกแล้ว สต็อกถูกคืนเข้าระบบเรียบร้อย
                </p>
              ) : (
                <Stepper status={order.status} />
              )}

              {order.status === 'ready_for_pickup' && order.pickupPin ? (
                /*
                 * Both credentials, side by side, because they fail differently: the
                 * QR is faster and cannot be mistyped, while the PIN survives a flat
                 * phone, a cracked screen and a customer reading it down the phone.
                 * Offering only one of them strands somebody eventually.
                 */
                <Stack gap="md">
                  {order.pickupToken ? (
                    <div className={styles.code}>
                      <QrCode
                        value={order.pickupToken}
                        size={200}
                        alt={`คิวอาร์รับสินค้า ${order.orderNumber}`}
                      />
                      <p className="ln-muted">สแกนคิวอาร์นี้ที่เคาน์เตอร์เพื่อรับสินค้า</p>
                    </div>
                  ) : null}

                  <InlineNotice tone="success" title="หรืออ่าน PIN นี้ให้พนักงานก็ได้">
                    <strong className="ln-figure ln-mono">{order.pickupPin}</strong>
                  </InlineNotice>
                </Stack>
              ) : null}

              {order.status === 'pending' ? (
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="close"
                    onClick={() => setCancelling(order)}
                  >
                    ยกเลิกออเดอร์
                  </Button>
                </div>
              ) : null}
            </Stack>
          </Card>
        ))
      )}

      <ConfirmDialog
        open={cancelling !== null}
        title="ยกเลิกออเดอร์นี้?"
        description={
          cancelling
            ? `ออเดอร์ ${cancelling.orderNumber} จะถูกยกเลิก และสต็อกที่จองไว้จะคืนเข้าระบบ — ย้อนกลับไม่ได้`
            : undefined
        }
        confirmLabel="ยกเลิกออเดอร์"
        busy={busy}
        onConfirm={() => {
          if (cancelling) {
            void cancel(cancelling);
          }
        }}
        onCancel={() => setCancelling(null)}
      />
    </Stack>
  );
}
