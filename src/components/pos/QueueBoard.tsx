'use client';

/**
 * The board the bar works from (ADR 0018).
 *
 * Two columns and one button each: what is being made, and what is waiting to be
 * collected. The number is the same one printed on the customer's slip, at a size
 * somebody can read from a step back — this screen is used standing up, with a
 * carton in the other hand.
 *
 * Read from the API on mount and on every nudging event, never built out of the
 * event payload itself: two tablets on one shop must show one board, and the one
 * that was asleep when an event fired still has to be right when it wakes up.
 */
import { useCallback, useEffect, useState } from 'react';

import { Button, EmptyState, InlineNotice, SkeletonRows } from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import { apiFetch, apiPost } from '@/lib/client-api';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

import styles from './QueueBoard.module.css';

interface QueueTicket {
  orderId: string;
  queueNumber: string;
  state: 'preparing' | 'ready' | 'collected';
  /** When it entered this state — what the elapsed counter counts from. */
  since: string;
  items: string[];
}

interface QueueResponse {
  tickets: QueueTicket[];
}

/**
 * How long a ticket has been in its current state, in the words a bar uses.
 *
 * Minutes rather than a clock time, because the question being asked of this figure
 * is "how long has this customer been standing there", and a timestamp makes the
 * reader do that subtraction themselves while holding a cup.
 */
function elapsedLabel(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  if (minutes < 1) {
    return 'เมื่อสักครู่';
  }
  return `รอ ${minutes} นาที`;
}

export function QueueBoard() {
  const [tickets, setTickets] = useState<QueueTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const { tickets: rows } = await apiFetch<QueueResponse>('/api/v1/pos/queue');
      setTickets(rows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'โหลดบอร์ดคิวไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The elapsed figures age on their own; nothing else on this screen changes
  // without an event, so this is the only thing that needs a clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useRealtimeEvent(REALTIME_EVENTS.queueUpdated, useCallback(() => void load(), [load]));

  const advance = useCallback(
    async (ticket: QueueTicket, action: 'mark_ready' | 'collect') => {
      setBusyId(ticket.orderId);
      try {
        await apiPost(`/api/v1/orders/${ticket.orderId}/fulfilment`, { action });
        /*
         * The board is re-read rather than patched locally. Another tablet may have
         * moved a different ticket a second ago, and a local edit would draw a board
         * that no longer matches the shop.
         */
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'อัปเดตคิวไม่สำเร็จ');
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const preparing = tickets.filter((ticket) => ticket.state === 'preparing');
  const ready = tickets.filter((ticket) => ticket.state === 'ready');

  const column = (
    title: string,
    rows: QueueTicket[],
    action: { label: string; icon: 'check' | 'cart'; run: 'mark_ready' | 'collect' },
    empty: string,
  ) => (
    <section className={styles.column} aria-label={title}>
      <h2 className={styles.columnTitle}>
        {title} <span className={styles.count}>{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className={styles.empty}>{empty}</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((ticket) => (
            <li key={ticket.orderId} className={styles.ticket}>
              <div className={styles.ticketHead}>
                <span className={styles.number}>{ticket.queueNumber}</span>
                <span className={styles.elapsed}>{elapsedLabel(ticket.since, now)}</span>
              </div>
              <p className={styles.items}>{ticket.items.join(' · ')}</p>
              <Button
                size="lg"
                icon={action.icon}
                loading={busyId === ticket.orderId}
                onClick={() => void advance(ticket, action.run)}
              >
                {action.label}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  if (loading) {
    return <SkeletonRows rows={3} />;
  }

  return (
    <>
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      {tickets.length === 0 ? (
        <EmptyState
          title="ยังไม่มีคิววันนี้"
          description="เปิดลิ้นชักแล้วขายหน้าร้านได้เลย เลขคิวของแต่ละบิลจะขึ้นที่นี่ทันทีที่ปิดการขาย"
        />
      ) : (
        <div className={styles.board}>
          {column('กำลังทำ', preparing, { label: 'เสร็จแล้ว', icon: 'check', run: 'mark_ready' }, 'ไม่มีคิวที่กำลังทำ')}
          {column('พร้อมรับ', ready, { label: 'รับแล้ว', icon: 'cart', run: 'collect' }, 'ยังไม่มีคิวที่ทำเสร็จ')}
        </div>
      )}
    </>
  );
}
