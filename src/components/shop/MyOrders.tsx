'use client';

import { useCallback, useEffect, useState } from 'react';

import { Alert, Badge, Card, EmptyState, Money, Spinner } from '@/components/hope/ui';
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
 * The member's own order list — SRS §2.
 *
 * The stepper is the four-phase lifecycle made legible to the customer, and the
 * pickup PIN appears the moment staff pack the order. It refreshes on realtime
 * events rather than polling, so "พร้อมรับ" appears on the customer's phone the
 * instant the shelf staff tag the bag.
 */
export function MyOrders() {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const cancel = async (orderId: string): Promise<void> => {
    try {
      await apiPost(`/api/v1/orders/${orderId}/cancel`, { reason: 'ลูกค้ายกเลิกเอง' });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ยกเลิกไม่สำเร็จ');
    }
  };

  if (loading) {
    return <Spinner />;
  }

  return (
    <div className="d-flex flex-column gap-3">
      <div>
        <h4 className="mb-1">ออเดอร์ของฉัน</h4>
        <p className="text-muted mb-0 small">ติดตามสถานะพรีออเดอร์แบบเรียลไทม์</p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {orders.length === 0 ? (
        <Card title="ยังไม่มีออเดอร์">
          <EmptyState title="ยังไม่มีออเดอร์" description="เลือกสินค้าและกดจองเพื่อเริ่มต้น" />
        </Card>
      ) : (
        orders.map((order) => {
          const stepIndex = STEPS.indexOf(order.status as (typeof STEPS)[number]);

          return (
            <Card
              key={order.id}
              title={<code className="small">{order.orderNumber}</code>}
              subtitle={`${order.itemCount} รายการ · ${new Date(order.createdAt).toLocaleString('th-TH')}`}
              actions={
                <>
                  <Badge
                    tone={
                      order.status === 'completed'
                        ? 'success'
                        : order.status === 'cancelled'
                          ? 'danger'
                          : order.status === 'ready_for_pickup'
                            ? 'primary'
                            : 'warning'
                    }
                  >
                    {STEP_LABEL[order.status]}
                  </Badge>
                  <Money amount={order.finalAmountThb} className="fw-bold" />
                </>
              }
            >
              {order.status === 'cancelled' ? (
                <p className="text-muted small mb-0">
                  ออเดอร์นี้ถูกยกเลิกแล้ว สต็อกถูกคืนเข้าระบบเรียบร้อย
                </p>
              ) : (
                <div className="d-flex align-items-center gap-2 mb-0">
                  {STEPS.map((step, index) => (
                    <div className="d-flex align-items-center gap-2 flex-grow-1" key={step}>
                      <span
                        className={`badge rounded-pill ${
                          index <= stepIndex ? 'bg-primary' : 'bg-soft-secondary text-secondary'
                        }`}
                      >
                        {index + 1}
                      </span>
                      <span
                        className={`small ${index <= stepIndex ? 'text-body' : 'text-muted'}`}
                      >
                        {STEP_LABEL[step]}
                      </span>
                      {index < STEPS.length - 1 && (
                        <span className={`flex-grow-1 border-top ${index < stepIndex ? 'border-primary' : ''}`} />
                      )}
                    </div>
                  ))}
                </div>
              )}

              {order.status === 'ready_for_pickup' && order.pickupPin && (
                <div className="alert alert-success mt-3 mb-0 py-2">
                  <span className="small d-block">แสดง PIN นี้ที่เคาน์เตอร์เพื่อรับสินค้า</span>
                  <span className="fs-3 fw-bold pos-receipt">{order.pickupPin}</span>
                </div>
              )}

              {order.status === 'pending' && (
                <button
                  type="button"
                  className="btn btn-sm btn-soft-danger mt-3"
                  onClick={() => void cancel(order.id)}
                >
                  ยกเลิกออเดอร์
                </button>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
