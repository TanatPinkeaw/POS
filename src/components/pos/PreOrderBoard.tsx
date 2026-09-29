'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  InlineNotice,
  Money,
  Overlay,
  Pill,
  SearchField,
  Spinner,
  Stack,
  StatusPill,
  TextField,
  Thumb,
  Toolbar,
  type Column,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import { handoverLookupBody } from '@/lib/pickup-scan';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import { playWarningChime } from '@/lib/sound';

import styles from './PreOrderBoard.module.css';
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
  items: {
    id: string;
    productId: string;
    name: string;
    /** The product's photo, or null — see the board's note on why the line shows one. */
    imageUrl: string | null;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }[];
}

/** SRS §3 Phase 1 deadline; the server is the authority, this is the display. */
const CONFIRM_TIMEOUT_MINUTES = 15;

/** Column definitions, in lifecycle order. */
const COLUMNS = [
  { status: 'pending', title: '1 · รอยืนยัน' },
  { status: 'confirmed', title: '2 · กำลังเตรียม' },
  { status: 'ready_for_pickup', title: '3 · พร้อมรับ' },
] as const;

function minutesLeft(createdAt: string, now: number): number {
  const deadline = new Date(createdAt).getTime() + CONFIRM_TIMEOUT_MINUTES * 60_000;
  return Math.max(0, Math.round((deadline - now) / 60_000));
}

/**
 * The pre-order board.
 *
 * Staff see all four phases at once and drive each order forward. Three things
 * make it usable on a busy counter: pending orders carry a live countdown so the
 * 15-minute timeout is visible before it fires; every action re-reads the server
 * rather than mutating local state, because the server is the only thing that
 * knows whether the stock guard actually passed; and the two writes that decide an
 * order's fate — confirming (possibly dropping a damaged item) and handing over
 * (taking money) — happen in dialogs, where the line items and the amounts have
 * room to be checked before anything is committed.
 *
 * Both of those dialogs list each line with the product's photo, when the shop has
 * one (ADR 0014). That is the moment the question is "which of these bags on the
 * shelf is this order's" — the order number answers nothing, the name answers it
 * slowly, and the picture answers it at a glance, which is the whole difference on a
 * counter with three orders waiting.
 *
 * Cancelling asks first. It releases reserved stock and texts a customer who is
 * already on their way, and it is one tap away from "ยืนยัน" on the same card.
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
  const [cancelling, setCancelling] = useState<{ order: OrderRow; reason: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await apiFetch<OrderRow[]>('/api/v1/orders?type=preorder&limit=100');
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
  useRealtimeEvent(
    REALTIME_EVENTS.orderExpired,
    useCallback(() => {
      playWarningChime();
      void load();
    }, [load]),
  );

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
      /*
       * One box, three shapes. A scanner types a JWS, the customer reads out four
       * digits, and the customer who lost the slip gives a phone number — and the
       * screen cannot ask which one it is, because at a counter that question is
       * already answered by what just arrived. See `looksLikePickupToken`.
       */
      const found = await apiPost<OrderDetail>(
        '/api/v1/orders/lookup',
        handoverLookupBody(term),
      );
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
    const points =
      settlement.usePoints && handover.customer
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

  const completedColumns: Column<OrderRow>[] = [
    {
      key: 'number',
      header: 'เลขที่',
      cardLabel: 'เลขที่',
      render: (order) => <span className="ln-mono">{order.orderNumber}</span>,
    },
    {
      key: 'customer',
      header: 'ลูกค้า',
      cardLabel: 'ลูกค้า',
      render: (order) => order.customerName ?? '—',
    },
    {
      key: 'amount',
      header: 'ยอด',
      cardLabel: 'ยอด',
      align: 'end',
      render: (order) => <Money amount={order.finalAmountThb} />,
    },
  ];

  const renderOrder = (order: OrderRow) => {
    const left = minutesLeft(order.createdAt, now);
    const urgent = order.status === 'pending' && left <= 5;
    const busy = busyId === order.id;

    return (
      <article className={styles.order} data-urgent={urgent} key={order.id}>
        <div className={styles.orderHead}>
          <span className="ln-mono">{order.orderNumber}</span>
          <Money amount={order.finalAmountThb} />
        </div>

        <span className={styles.meta}>
          {order.customerName ?? 'ลูกค้าทั่วไป'} · {order.customerPhone ?? '—'} · {order.itemCount}{' '}
          รายการ
        </span>

        {order.status === 'pending' ? (
          <p className={urgent ? styles.urgent : styles.countdown}>
            เหลือเวลา {left} นาที ก่อนหมดอายุอัตโนมัติ
          </p>
        ) : null}

        {order.status === 'ready_for_pickup' && order.pickupPin ? (
          <p className="ln-row">
            <span className={styles.meta}>PIN</span>
            <strong className="ln-figure ln-mono">{order.pickupPin}</strong>
          </p>
        ) : null}

        <div className="ln-row">
          {order.status === 'pending' ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void openConfirm(order.id)}>
                ยืนยัน
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setCancelling({ order, reason: 'พนักงานยกเลิก' })}
              >
                ยกเลิก
              </Button>
            </>
          ) : null}

          {order.status === 'confirmed' ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act(order.id, 'ready', {})}
              >
                แพ็คเสร็จ / พร้อมรับ
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setCancelling({ order, reason: 'สินค้าไม่พร้อม' })}
              >
                ยกเลิก
              </Button>
            </>
          ) : null}

          {order.status === 'ready_for_pickup' ? (
            <>
              <Button
                variant="success"
                size="sm"
                icon="cash"
                disabled={busy}
                onClick={() => void openHandover(order)}
              >
                รับสินค้า + ชำระ
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setCancelling({ order, reason: 'ลูกค้าไม่มารับ' })}
              >
                ไม่มารับ
              </Button>
            </>
          ) : null}

          {order.status === 'completed' ? <Pill tone="success">ปิดการขายแล้ว</Pill> : null}
        </div>
      </article>
    );
  };

  return (
    <Stack gap="md">
      <Toolbar
        actions={
          <Button variant="secondary" icon="search" onClick={() => void lookupOrder()}>
            ค้นหา
          </Button>
        }
      >
        <SearchField
          id="preorder-lookup"
          label="สแกนคิวอาร์ หรือค้นหาด้วย PIN 4 หลัก / เบอร์โทรลูกค้า"
          placeholder="สแกนคิวอาร์, PIN 4 หลัก, หรือเบอร์โทร"
          value={lookup}
          onChange={setLookup}
          onSubmit={() => void lookupOrder()}
          mono
        />
      </Toolbar>

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      {loading ? <Spinner /> : null}

      <div className={styles.board}>
        {COLUMNS.map((column) => {
          const rows = grouped.get(column.status) ?? [];
          return (
            <Card
              key={column.status}
              title={column.title}
              actions={<StatusPill status={column.status} label={String(rows.length)} />}
            >
              {rows.length === 0 ? (
                <p className="ln-muted">ว่าง</p>
              ) : (
                <Stack gap="sm">{rows.map(renderOrder)}</Stack>
              )}
            </Card>
          );
        })}
      </div>

      {/*
       * The day's takings, full width under the board rather than a fourth
       * column: it is a table of three fields, and a 280px column would crush
       * every row of it.
       */}
      <Card
        title="ปิดการขายวันนี้"
        actions={<Pill tone="success">{grouped.get('completed')?.length ?? 0}</Pill>}
        flush
      >
        <DataTable
          columns={completedColumns}
          rows={grouped.get('completed') ?? []}
          getRowKey={(order) => order.id}
          caption="ออเดอร์พรีออเดอร์ที่ปิดการขายแล้ววันนี้"
          dense
          empty={<EmptyState icon="receipt" title="ยังไม่มีออเดอร์ที่ปิดการขายวันนี้" />}
        />
      </Card>

      {/* Phase 2: confirm, with the partial-confirmation item remover. */}
      <Overlay
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming ? `ยืนยันออเดอร์ ${confirming.orderNumber}` : ''}
        description="ถ้าสินค้าชิ้นใดเสียหายหรือไม่พร้อม ให้ติ๊กเพื่อตัดออก ระบบจะคืนสต็อกที่จองไว้ให้ทันที"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              ยกเลิก
            </Button>
            <Button
              icon="check"
              disabled={busyId === confirming?.id}
              onClick={() => {
                if (!confirming) {
                  return;
                }
                const id = confirming.id;
                setConfirming(null);
                void act(id, 'confirm', { removeItemIds: removeIds });
              }}
            >
              ยืนยันออเดอร์
            </Button>
          </>
        }
      >
        <ul className={styles.lines}>
          {confirming?.items.map((item) => (
            <li className={styles.lineItem} key={item.id}>
              <label className={`${styles.pick} ${styles.pickLine}`}>
                <input
                  type="checkbox"
                  checked={removeIds.includes(item.id)}
                  onChange={(event) =>
                    setRemoveIds((current) =>
                      event.target.checked
                        ? [...current, item.id]
                        : current.filter((id) => id !== item.id),
                    )
                  }
                />
                <Thumb url={item.imageUrl} size="sm" />
                <span className={styles.lineName}>
                  ตัดออก: {item.name} × {item.quantity}
                </span>
              </label>
              <Money amount={item.totalPrice} />
            </li>
          ))}
        </ul>
      </Overlay>

      {/* Phase 4: handover and settlement. */}
      <Overlay
        open={handover !== null}
        onClose={() => setHandover(null)}
        title={handover ? `รับสินค้า ${handover.orderNumber}` : ''}
        description={handover?.customer ? `สมาชิก ${handover.customer.fullName}` : 'ลูกค้าทั่วไป'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setHandover(null)}>
              ปิด
            </Button>
            <Button
              variant="success"
              icon="cash"
              disabled={busyId === handover?.id || !shift}
              onClick={() => void complete()}
            >
              ยืนยันการชำระเงิน
            </Button>
          </>
        }
      >
        <Stack gap="md">
          {!shift ? (
            <InlineNotice tone="warning">ต้องเปิดลิ้นชักก่อน จึงจะรับชำระเงินได้</InlineNotice>
          ) : null}

          <ul className={styles.lines}>
            {handover?.items.map((item) => (
              <li className={styles.lineItem} key={item.id}>
                <Thumb url={item.imageUrl} size="sm" />
                <span className={`${styles.lineName} ln-break`}>
                  {item.name} × {item.quantity}
                </span>
                <Money amount={item.totalPrice} />
              </li>
            ))}
          </ul>

          <div className={styles.line}>
            <span>ยอดที่ต้องชำระ</span>
            <Money amount={handover?.finalAmountThb ?? 0} size="lg" />
          </div>

          {handover?.customer && handover.customer.pointsBalance >= 100 ? (
            <label className={styles.pick}>
              <input
                type="checkbox"
                checked={settlement.usePoints}
                onChange={(event) =>
                  setSettlement((current) => ({ ...current, usePoints: event.target.checked }))
                }
              />
              <span>
                ใช้คะแนน {handover.customer.pointsBalance} คะแนน ของ {handover.customer.fullName}
              </span>
            </label>
          ) : null}

          <div className="ln-row">
            <TextField
              id="handover-cash"
              label="เงินสดที่รับ (บาท)"
              inputMode="decimal"
              className="ln-num"
              value={settlement.cash}
              onChange={(event) =>
                setSettlement((current) => ({ ...current, cash: event.target.value }))
              }
            />
            <TextField
              id="handover-received"
              label="ลูกค้ายื่นมา (บาท)"
              inputMode="decimal"
              className="ln-num"
              value={settlement.receivedCash}
              onChange={(event) =>
                setSettlement((current) => ({ ...current, receivedCash: event.target.value }))
              }
            />
          </div>
        </Stack>
      </Overlay>

      <ConfirmDialog
        open={cancelling !== null}
        title="ยกเลิกออเดอร์นี้?"
        description={
          cancelling
            ? `ออเดอร์ ${cancelling.order.orderNumber} จะถูกยกเลิก และสต็อกที่จองไว้จะคืนเข้าระบบทันที`
            : undefined
        }
        confirmLabel="ยกเลิกออเดอร์"
        busy={busyId === cancelling?.order.id}
        onConfirm={() => {
          if (!cancelling) {
            return;
          }
          const { order, reason } = cancelling;
          setCancelling(null);
          void act(order.id, 'cancel', { reason });
        }}
        onCancel={() => setCancelling(null)}
      />
    </Stack>
  );
}
