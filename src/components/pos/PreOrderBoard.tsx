'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge, Card, EmptyState, Money, Spinner } from '@/components/hope/ui';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import { playWarningChime } from '@/lib/sound';

import { useOpenShift } from './useOpenShift';

interface OrderRow {
  id: string;
  orderNumber: string;
  status: 'pending' | 'confirmed' | 'ready_for_pickup' | 'completed' | 'cancelled';
  finalAmountThb: number;
  itemCount: number;
  customerName: string | null;
  customerPhone: string | null;
  pickupPin: string | null;
  createdAt: string;
  readyAt: string | null;
}

interface OrderDetail {
  id: string;
  orderNumber: string;
  status: string;
  finalAmountThb: number;
  pickupPin: string | null;
  customer: { id: string; fullName: string; phone: string; pointsBalance: number } | null;
  items: { id: string; productId: string; name: string; quantity: number; unitPrice: number; totalPrice: number }[];
}

/** SRS §3 Phase 1 deadline; the server is the authority, this is the display. */
const CONFIRM_TIMEOUT_MINUTES = 15;

/** Column definitions, in lifecycle order. */
const COLUMNS = [
  { status: 'pending', title: '1 · รอยืนยัน', tone: 'warning' },
  { status: 'confirmed', title: '2 · กำลังเตรียม', tone: 'info' },
  { status: 'ready_for_pickup', title: '3 · พร้อมรับ', tone: 'primary' },
] as const;

function minutesLeft(createdAt: string, now: number): number {
  const deadline = new Date(createdAt).getTime() + CONFIRM_TIMEOUT_MINUTES * 60_000;
  return Math.max(0, Math.round((deadline - now) / 60_000));
}

/**
 * The pre-order board.
 *
 * Staff see all four phases at once and drive each order forward. Two things
 * make it usable on a busy counter: pending orders carry a live countdown so the
 * 15-minute timeout is visible before it fires, and every action re-reads the
 * server rather than mutating local state — the server is the only thing that
 * knows whether the stock guard actually passed.
 */
export function PreOrderBoard() {
  const { shift } = useOpenShift();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [lookup, setLookup] = useState('');
  const [handover, setHandover] = useState<OrderDetail | null>(null);
  const [settlement, setSettlement] = useState({ cash: '', receivedCash: '', usePoints: false });
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<OrderDetail | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await apiFetch<OrderRow[]>(
        '/api/v1/orders?type=preorder&limit=100',
      );
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

  // Countdown ticker for the Phase 1 deadline.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Any change from any terminal re-reads the list.
  useRealtimeEvent(REALTIME_EVENTS.orderCreated, useCallback(() => void load(), [load]));
  useRealtimeEvent(REALTIME_EVENTS.orderUpdated, useCallback(() => void load(), [load]));
  useRealtimeEvent(REALTIME_EVENTS.orderExpired, useCallback(() => {
    playWarningChime();
    void load();
  }, [load]));

  const grouped = useMemo(() => {
    const map = new Map<string, OrderRow[]>([
      ['pending', []],
      ['confirmed', []],
      ['ready_for_pickup', []],
      ['completed', []],
    ]);
    for (const order of orders) {
      if (order.status === 'cancelled') {
        continue;
      }
      // Only today's completed orders stay on the board.
      if (order.status === 'completed') {
        if (!order.readyAt || new Date(order.readyAt).toDateString() !== new Date().toDateString()) {
          continue;
        }
      }
      map.get(order.status)?.push(order);
    }
    return map;
  }, [orders]);

  const act = async (orderId: string, path: string, body: unknown): Promise<void> => {
    setBusyId(orderId);
    setError(null);
    try {
      await apiPost(`/api/v1/orders/${orderId}/${path}`, body);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ดำเนินการไม่สำเร็จ');
    } finally {
      setBusyId(null);
    }
  };

  const openConfirm = async (orderId: string): Promise<void> => {
    setBusyId(orderId);
    try {
      const detail = await apiFetch<OrderDetail>(`/api/v1/orders/${orderId}`);
      setConfirming(detail);
      setRemoveIds([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เปิดรายละเอียดไม่สำเร็จ');
    } finally {
      setBusyId(null);
    }
  };

  const openHandover = async (order: OrderRow): Promise<void> => {
    setBusyId(order.id);
    try {
      const detail = await apiFetch<OrderDetail>(`/api/v1/orders/${order.id}`);
      setHandover(detail);
      setSettlement({ cash: String(detail.finalAmountThb), receivedCash: '', usePoints: false });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เปิดรายละเอียดไม่สำเร็จ');
    } finally {
      setBusyId(null);
    }
  };

  const lookupOrder = async (): Promise<void> => {
    const term = lookup.trim();
    if (!term) {
      return;
    }
    setError(null);
    try {
      const isPin = /^\d{4}$/.test(term);
      const found = await apiPost<OrderDetail>('/api/v1/orders/lookup', {
        ...(isPin ? { pin: term } : { phone: term }),
      });
      setHandover(found);
      setSettlement({ cash: String(found.finalAmountThb), receivedCash: '', usePoints: false });
      setLookup('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ไม่พบออเดอร์');
    }
  };

  const complete = async (): Promise<void> => {
    if (!handover) {
      return;
    }
    if (!shift) {
      setError('ต้องเปิดลิ้นชักก่อนรับชำระเงิน');
      return;
    }

    const cash = Number(settlement.cash || 0);
    const points = settlement.usePoints && handover.customer
      ? Math.floor(handover.customer.pointsBalance / 100) * 100
      : 0;

    setBusyId(handover.id);
    setError(null);
    try {
      await apiPost(`/api/v1/orders/${handover.id}/complete`, {
        shiftId: shift.id,
        settlement: {
          points,
          cash,
          receivedCash: Number(settlement.receivedCash || cash),
        },
      });
      setHandover(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ปิดการขายไม่สำเร็จ');
    } finally {
      setBusyId(null);
    }
  };

  const renderCard = (order: OrderRow) => {
    const left = minutesLeft(order.createdAt, now);
    const urgent = order.status === 'pending' && left <= 5;
    const busy = busyId === order.id;

    return (
      <div className={`card mb-2 ${urgent ? 'pos-urgent' : ''}`} key={order.id}>
        <div className="card-body p-3">
          <div className="d-flex justify-content-between align-items-start mb-1">
            <code className="small">{order.orderNumber}</code>
            <Money amount={order.finalAmountThb} className="small fw-bold" />
          </div>

          <p className="mb-1 small">{order.customerName ?? 'ลูกค้าทั่วไป'}</p>
          <p className="text-muted mb-2 small">
            {order.customerPhone} · {order.itemCount} รายการ
          </p>

          {order.status === 'pending' && (
            <p className={`small mb-2 ${urgent ? 'text-danger fw-bold' : 'text-muted'}`}>
              เหลือเวลา {left} นาที ก่อนหมดอายุอัตโนมัติ
            </p>
          )}

          {order.status === 'ready_for_pickup' && order.pickupPin && (
            <p className="small mb-2">
              PIN: <span className="badge bg-soft-primary text-primary fs-6">{order.pickupPin}</span>
            </p>
          )}

          <div className="d-flex flex-wrap gap-1">
            {order.status === 'pending' && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void openConfirm(order.id)}
                >
                  ยืนยัน
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-soft-danger"
                  disabled={busy}
                  onClick={() =>
                    void act(order.id, 'cancel', { reason: 'พนักงานยกเลิก' })
                  }
                >
                  ยกเลิก
                </button>
              </>
            )}

            {order.status === 'confirmed' && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => void act(order.id, 'ready', {})}
                >
                  แพ็คเสร็จ / พร้อมรับ
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-soft-danger"
                  disabled={busy}
                  onClick={() => void act(order.id, 'cancel', { reason: 'สินค้าไม่พร้อม' })}
                >
                  ยกเลิก
                </button>
              </>
            )}

            {order.status === 'ready_for_pickup' && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-success"
                  disabled={busy}
                  onClick={() => void openHandover(order)}
                >
                  รับสินค้า + ชำระ
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-soft-danger"
                  disabled={busy}
                  onClick={() => void act(order.id, 'cancel', { reason: 'ลูกค้าไม่มารับ' })}
                >
                  ไม่มารับ
                </button>
              </>
            )}

            {order.status === 'completed' && <Badge tone="success">ปิดการขายแล้ว</Badge>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex justify-content-between align-items-end flex-wrap gap-2">
        <div>
          <h4 className="mb-1">กระดานพรีออเดอร์</h4>
          <p className="text-muted mb-0 small">
            ออเดอร์ที่ไม่ได้ยืนยันภายใน {CONFIRM_TIMEOUT_MINUTES} นาที จะถูกยกเลิกและคืนสต็อกอัตโนมัติ
          </p>
        </div>
        <div className="d-flex gap-2">
          <input
            className="form-control form-control-sm"
            style={{ minWidth: 200 }}
            placeholder="ค้นหาด้วย PIN 4 หลัก หรือเบอร์โทร"
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void lookupOrder();
              }
            }}
          />
          <button type="button" className="btn btn-sm btn-primary text-nowrap" onClick={() => void lookupOrder()}>
            ค้นหา
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger py-2 small">{error}</div>}
      {loading && <Spinner />}

      <div className="row g-3">
        {COLUMNS.map((column) => (
          <div className="col-12 col-xl-4" key={column.status}>
            <Card
              title={column.title}
              actions={<Badge tone={column.tone}>{grouped.get(column.status)?.length ?? 0}</Badge>}
              bodyClassName="pos-board-column"
            >
              {grouped.get(column.status)?.length === 0 ? (
                <p className="text-muted small mb-0">ว่าง</p>
              ) : (
                grouped.get(column.status)?.map(renderCard)
              )}
            </Card>
          </div>
        ))}
      </div>

      <Card
        title="ปิดการขายวันนี้"
        actions={<Badge tone="success">{grouped.get('completed')?.length ?? 0}</Badge>}
      >
        {grouped.get('completed')?.length === 0 ? (
          <EmptyState title="ยังไม่มีออเดอร์ที่ปิดการขายวันนี้" />
        ) : (
          <div className="table-responsive">
            <table className="table table-sm mb-0">
              <thead>
                <tr>
                  <th>เลขที่</th>
                  <th>ลูกค้า</th>
                  <th className="pos-numeric">ยอด</th>
                </tr>
              </thead>
              <tbody>
                {grouped.get('completed')?.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <code className="small">{order.orderNumber}</code>
                    </td>
                    <td className="small">{order.customerName ?? '—'}</td>
                    <td className="pos-numeric">
                      <Money amount={order.finalAmountThb} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Phase 2: confirm, with the partial-confirmation item remover. */}
      {confirming && (
        <div className="modal fade show d-block" role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">ยืนยันออเดอร์ {confirming.orderNumber}</h5>
                <button type="button" className="btn-close" onClick={() => setConfirming(null)} />
              </div>
              <div className="modal-body">
                <p className="text-muted small">
                  ถ้าสินค้าชิ้นใดเสียหายหรือไม่พร้อม ให้ติ๊กเพื่อตัดออก ระบบจะคืนสต็อกที่จองไว้ให้ทันที
                </p>
                <ul className="list-group">
                  {confirming.items.map((item) => (
                    <li className="list-group-item d-flex justify-content-between align-items-center" key={item.id}>
                      <div className="form-check">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id={`remove-${item.id}`}
                          checked={removeIds.includes(item.id)}
                          onChange={(event) =>
                            setRemoveIds((current) =>
                              event.target.checked
                                ? [...current, item.id]
                                : current.filter((id) => id !== item.id),
                            )
                          }
                        />
                        <label className="form-check-label small" htmlFor={`remove-${item.id}`}>
                          ตัดออก: {item.name} × {item.quantity}
                        </label>
                      </div>
                      <Money amount={item.totalPrice} className="small" />
                    </li>
                  ))}
                </ul>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-soft-secondary" onClick={() => setConfirming(null)}>
                  ยกเลิก
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busyId === confirming.id}
                  onClick={() => {
                    const id = confirming.id;
                    setConfirming(null);
                    void act(id, 'confirm', { removeItemIds: removeIds });
                  }}
                >
                  ยืนยันออเดอร์
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Phase 4: handover and settlement. */}
      {handover && (
        <div className="modal fade show d-block" role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">รับสินค้า {handover.orderNumber}</h5>
                <button type="button" className="btn-close" onClick={() => setHandover(null)} />
              </div>
              <div className="modal-body">
                {!shift && (
                  <div className="alert alert-warning py-2 small">
                    ต้องเปิดลิ้นชักก่อน จึงจะรับชำระเงินได้
                  </div>
                )}

                <ul className="list-group mb-3">
                  {handover.items.map((item) => (
                    <li className="list-group-item d-flex justify-content-between small" key={item.id}>
                      <span>
                        {item.name} × {item.quantity}
                      </span>
                      <Money amount={item.totalPrice} />
                    </li>
                  ))}
                </ul>

                <div className="d-flex justify-content-between fw-bold mb-3">
                  <span>ยอดที่ต้องชำระ</span>
                  <Money amount={handover.finalAmountThb} />
                </div>

                {handover.customer && handover.customer.pointsBalance >= 100 && (
                  <div className="form-check mb-2">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      id="handover-points"
                      checked={settlement.usePoints}
                      onChange={(event) =>
                        setSettlement((current) => ({ ...current, usePoints: event.target.checked }))
                      }
                    />
                    <label className="form-check-label small" htmlFor="handover-points">
                      ใช้คะแนน {handover.customer.pointsBalance} คะแนน ของ {handover.customer.fullName}
                    </label>
                  </div>
                )}

                <div className="row g-2">
                  <div className="col-6">
                    <label className="form-label small" htmlFor="handover-cash">
                      เงินสดที่รับ (บาท)
                    </label>
                    <input
                      id="handover-cash"
                      className="form-control form-control-sm pos-numeric"
                      inputMode="decimal"
                      value={settlement.cash}
                      onChange={(event) =>
                        setSettlement((current) => ({ ...current, cash: event.target.value }))
                      }
                    />
                  </div>
                  <div className="col-6">
                    <label className="form-label small" htmlFor="handover-received">
                      ลูกค้ายื่นมา (บาท)
                    </label>
                    <input
                      id="handover-received"
                      className="form-control form-control-sm pos-numeric"
                      inputMode="decimal"
                      value={settlement.receivedCash}
                      onChange={(event) =>
                        setSettlement((current) => ({ ...current, receivedCash: event.target.value }))
                      }
                    />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-soft-secondary" onClick={() => setHandover(null)}>
                  ปิด
                </button>
                <button
                  type="button"
                  className="btn btn-success"
                  disabled={busyId === handover.id || !shift}
                  onClick={() => void complete()}
                >
                  ยืนยันการชำระเงิน
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
