'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Button,
  Card,
  Carousel,
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
  Thumb,
  Toolbar,
  type Column,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { ApiError, apiFetch, apiPost } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import { playWarningChime } from '@/lib/sound';

import styles from './PreOrderBoard.module.css';
import { PreOrderHandover, lookupHandoverOrder, type HandoverOrder } from './PreOrderHandover';

interface OrderRow {
  id: string;
  orderNumber: string;
  status: 'pending' | 'confirmed' | 'ready_for_pickup' | 'completed' | 'cancelled';
  finalAmountThb: number;
  itemCount: number;
  customerName: string | null;
  customerPhone: string | null;
  pickupPin: string | null;
  /**
   * When the shop must confirm this order or it releases itself — written by the
   * server when the order was placed and read straight back, rather than
   * recomputed here from the shop's timeout setting.
   */
  confirmDeadline: string | null;
  createdAt: string;
  readyAt: string | null;
}

interface OrderDetail extends HandoverOrder {
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

/** Column definitions, in lifecycle order. */
const COLUMNS = [
  { status: 'pending', title: '1 · รอยืนยัน' },
  { status: 'confirmed', title: '2 · กำลังเตรียม' },
  { status: 'ready_for_pickup', title: '3 · พร้อมรับ' },
] as const;

/**
 * The countdown on one order.
 *
 * Its own component with its own clock, for a reason that turned out to be the
 * difference between a usable board and an unusable one. This used to be a single
 * `setInterval` in the board setting `now`, which re-rendered all three columns and
 * every card in them once a second — and because `Overlay`'s focus effect was keyed
 * on its `onClose` prop (a fresh arrow function every render), opening the handover
 * dialog while that clock ran meant the caret was thrown out of the cash field back
 * onto the first button, once a second, for as long as the dialog was open.
 *
 * Moving the tick inside the one card that shows a number fixes both halves at once:
 * the board no longer re-renders on a timer, and the dialog is no longer open next
 * to a clock.
 */
function Countdown({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Once a second, but only while this card is mounted — a column of finished
    // orders has no countdown and therefore no timer.
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const left = Math.max(0, Math.round((new Date(deadline).getTime() - now) / 60_000));
  const urgent = left <= 5;

  return (
    <p className={urgent ? styles.urgent : styles.countdown} role="status">
      เหลือเวลา {left} นาที ก่อนหมดอายุอัตโนมัติ
    </p>
  );
}

/**
 * The pre-order board.
 *
 * Staff see all four phases at once and drive each order forward. Three things
 * make it usable on a busy counter: pending orders carry a live countdown so the
 * timeout is visible before it fires; every action re-reads the server
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
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [lookup, setLookup] = useState('');
  const [handover, setHandover] = useState<HandoverOrder | null>(null);
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
      const detail = await apiFetch<HandoverOrder>(`/api/v1/orders/${order.id}`);
      setHandover(detail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เปิดรายละเอียดไม่สำเร็จ');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * One box, three shapes. A scanner types a JWS, the customer reads out four
   * digits, and the customer who lost the slip gives a phone number — and the
   * screen cannot ask which one it is, because at a counter that question is
   * already answered by what just arrived. See `handoverLookupBody`.
   */
  const lookupOrder = async (): Promise<void> => {
    const term = lookup.trim();
    if (!term) {
      return;
    }
    setError(null);
    try {
      const found = await lookupHandoverOrder(term);
      setHandover(found);
      setLookup('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'ไม่พบออเดอร์');
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
    const busy = busyId === order.id;

    return (
      <article className={styles.order} key={order.id}>
        <div className={styles.orderHead}>
          <span className="ln-mono">{order.orderNumber}</span>
          <Money amount={order.finalAmountThb} />
        </div>

        <span className={styles.meta}>
          {order.customerName ?? 'ลูกค้าทั่วไป'} · {order.customerPhone ?? '—'} · {order.itemCount}{' '}
          รายการ
        </span>

        {order.status === 'pending' && order.confirmDeadline ? (
          <Countdown deadline={order.confirmDeadline} />
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
          placeholder="สแกน QR, PIN, เบอร์โทร"
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
              className={styles.column}
              actions={<StatusPill status={column.status} label={String(rows.length)} />}
            >
              {/*
               * One card at a time, swiped rather than scrolled. The three columns used
               * to be three lists, so a queue of fourteen unconfirmed orders was a
               * column fourteen cards tall and the two the cashier needed were a
               * scroll away from a screen read from standing up. The carousel keeps the
               * column the height of one card, keeps every card tappable, and shows
               * the position — which is the trade for not letting it move by itself.
               */}
              <div className={styles.lane}>
                <Carousel
                  label={`ออเดอร์${column.title.replace(/^\d+\s·\s*/, '')}`}
                  empty={<p className="ln-muted">ว่าง</p>}
                >
                  {rows.map(renderOrder)}
                </Carousel>
              </div>
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

      {/*
       * Phase 4 lives in its own component because two screens open it: this board
       * and the till at `/pos`, where a customer holding a collection QR gets paid
       * without being walked to another tab.
       */}
      <PreOrderHandover
        order={handover}
        open={handover !== null}
        onClose={() => setHandover(null)}
        onCompleted={() => {
          setHandover(null);
          void load();
        }}
      />

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