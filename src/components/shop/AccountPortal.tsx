'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Button,
  Card,
  EmptyState,
  InlineNotice,
  Money,
  Pill,
  Spinner,
  Stack,
  Tabs,
  TextField,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import type { ReceiptData } from '@/components/pos/Receipt';
import { ApiError, apiFetch, apiPatch, apiPost } from '@/lib/client-api';
import { receiptImageDataUrl } from '@/lib/receipt-image';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import type { ShopView } from '@/lib/shop-view';

import styles from './AccountPortal.module.css';

interface PointEntry {
  id: string;
  pointsChange: number;
  balanceAfter: number;
  description: string | null;
  orderId: string | null;
  createdAt: string;
}

interface PointsPage {
  balance: number;
  entries: PointEntry[];
}

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  finalAmountThb: number;
  itemCount: number;
  createdAt: string;
}

interface ReceiptPayload {
  shop: ShopView;
  receipt: ReceiptData;
}

/**
 * The customer's own account — points, receipts and their number (ADR 0020, ADR 0021).
 *
 * Three panels behind one tab list, because they are three questions about one
 * account and a member on a phone should not walk through three screens to answer
 * them. Every call is to a route that scopes by the session, so "another customer's
 * data" is unreachable by construction rather than by this component checking.
 *
 * The phone panel is the one that *acts*: the number is the identity, so changing it
 * sends a code to the **new** number and the change only lands once that code comes
 * back (ADR 0020 §5). The server owns that rule — the form simply shows both steps.
 */
export function AccountPortal({
  phone,
  pointsBalance,
}: {
  phone: string;
  pointsBalance: number;
}) {
  const [tab, setTab] = useState('points');

  return (
    <Stack gap="lg">
      <Tabs
        label="บัญชีของฉัน"
        value={tab}
        onChange={setTab}
        items={[
          { key: 'points', label: 'คะแนน', badge: pointsBalance.toLocaleString('en-US') },
          { key: 'receipts', label: 'ใบเสร็จ' },
          { key: 'phone', label: 'เบอร์โทรศัพท์' },
        ]}
      />

      {tab === 'points' ? <PointsPanel /> : null}
      {tab === 'receipts' ? <ReceiptsPanel /> : null}
      {tab === 'phone' ? <PhonePanel phone={phone} /> : null}
    </Stack>
  );
}

/* ------------------------------------------------------------------ points */

function PointsPanel() {
  const [page, setPage] = useState<PointsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(await apiFetch<PointsPage>('/api/v1/points'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'โหลดคะแนนไม่สำเร็จ');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtimeEvent(REALTIME_EVENTS.pointsUpdated, useCallback(() => void load(), [load]));

  if (page === null && error === null) {
    return <Spinner />;
  }

  return (
    <Stack gap="md">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {page ? (
        <Card
          title="คะแนนสะสม"
          actions={
            <Pill tone="warning" icon="star">
              {page.balance.toLocaleString('en-US')} คะแนน
            </Pill>
          }
        >
          <p className="ln-muted">
            คะแนนมีค่า 100 คะแนน = 1 บาท ใช้เป็นส่วนลดได้เมื่อซื้อสินค้า — ทุก 3 บาทที่จ่ายได้ 1 คะแนน
          </p>
        </Card>
      ) : null}

      {page && page.entries.length === 0 ? (
        <Card>
          <EmptyState
            icon="coins"
            title="ยังไม่มีประวัติคะแนน"
            description="คะแนนจะเริ่มสะสมเมื่อคุณซื้อสินค้าและแจ้งเบอร์กับพนักงาน"
          />
        </Card>
      ) : null}

      {page && page.entries.length > 0 ? (
        <Card title="ประวัติคะแนน" subtitle="ใหม่สุดก่อน">
          <ul className={styles.ledger}>
            {page.entries.map((entry) => (
              <li key={entry.id} className={styles.ledgerRow}>
                <div className={styles.ledgerMain}>
                  <span className={styles.ledgerWhat}>
                    {entry.description ?? (entry.pointsChange >= 0 ? 'ได้รับคะแนน' : 'ใช้คะแนน')}
                  </span>
                  <span className="ln-muted">
                    {new Date(entry.createdAt).toLocaleString('th-TH')}
                  </span>
                </div>
                <div className={styles.ledgerFigures}>
                  <span
                    className={
                      entry.pointsChange >= 0 ? styles.ledgerEarn : styles.ledgerSpend
                    }
                  >
                    {entry.pointsChange >= 0 ? '+' : ''}
                    {entry.pointsChange.toLocaleString('en-US')}
                  </span>
                  <span className="ln-muted">
                    คงเหลือ {entry.balanceAfter.toLocaleString('en-US')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Stack>
  );
}

/* ---------------------------------------------------------------- receipts */

function ReceiptsPanel() {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closedId, setClosedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await apiFetch<OrderRow[]>('/api/v1/orders?status=completed&limit=50');
      setOrders(rows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'โหลดใบเสร็จไม่สำเร็จ');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtimeEvent(REALTIME_EVENTS.orderUpdated, useCallback(() => void load(), [load]));

  async function download(order: OrderRow): Promise<void> {
    setBusyId(order.id);
    setError(null);
    setClosedId(null);
    try {
      const payload = await apiFetch<ReceiptPayload>(`/api/v1/orders/${order.id}/receipt`);
      // The same renderer the browser journey proves (ADR 0021): the customer's own
      // figures, drawn here rather than read back from a stored file.
      const dataUrl = receiptImageDataUrl(payload.shop, payload.receipt);

      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `${order.orderNumber}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 410) {
        setClosedId(order.id);
      } else {
        setError(caught instanceof Error ? caught.message : 'ดาวน์โหลดใบเสร็จไม่สำเร็จ');
      }
    } finally {
      setBusyId(null);
    }
  }

  if (orders === null && error === null) {
    return <Spinner />;
  }

  return (
    <Stack gap="md">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {orders && orders.length === 0 ? (
        <Card>
          <EmptyState
            icon="receipt"
            title="ยังไม่มีใบเสร็จ"
            description="เมื่อคุณซื้อสินค้าและชำระเงินแล้ว ใบเสร็จจะแสดงที่นี่"
          />
        </Card>
      ) : null}

      {orders && orders.length > 0 ? (
        <Card title="ใบเสร็จของฉัน" subtitle="ดาวน์โหลดได้ภายใน 1 เดือนหลังการซื้อ">
          <ul className={styles.ledger}>
            {orders.map((order) => (
              <li key={order.id} className={styles.ledgerRow}>
                <div className={styles.ledgerMain}>
                  <span className={`ln-mono ${styles.ledgerWhat}`}>{order.orderNumber}</span>
                  <span className="ln-muted">
                    {new Date(order.createdAt).toLocaleString('th-TH')} · {order.itemCount} รายการ
                  </span>
                </div>
                <div className={styles.ledgerFigures}>
                  <Money amount={order.finalAmountThb} />
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="download"
                    loading={busyId === order.id}
                    onClick={() => void download(order)}
                  >
                    ดาวน์โหลด
                  </Button>
                </div>
                {closedId === order.id ? (
                  <p className={styles.closed}>
                    ใบเสร็จนี้เกิน 1 เดือนแล้ว — ยังแสดงรายการได้ แต่ดาวน์โหลดไม่ได้
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------------- phone */

/**
 * Changing the number, in two steps.
 *
 * The code is sent to the **new** number, and the change is only attempted once one
 * is entered — the server refuses a change whose code does not match the number it
 * was sent to, so this form cannot be used to move a number the customer does not
 * hold. Sending is a separate tap because it costs a message; confirming is the only
 * step that writes.
 */
function PhonePanel({ phone }: { phone: string }) {
  const [current, setCurrent] = useState(phone);
  const [next, setNext] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);

  const normalised = next.replace(/[\s()\-.]/g, '');

  async function sendCode(): Promise<void> {
    setError(null);
    setSending(true);
    try {
      await apiPost('/api/v1/auth/otp', { phone: next.trim() });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ส่งรหัสไม่สำเร็จ');
    } finally {
      setSending(false);
    }
  }

  async function confirm(): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      const result = await apiPatch<{ phone: string }>('/api/v1/auth/phone', {
        phone: next.trim(),
        code: code.trim(),
      });
      setCurrent(result.phone);
      setNext('');
      setCode('');
      setSent(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เปลี่ยนเบอร์ไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap="md">
      <Card
        title="เบอร์โทรศัพท์"
        subtitle="เบอร์คือตัวตนของคุณ — คะแนนและประวัติการซื้อผูกกับเบอร์นี้"
      >
        <p className={styles.currentPhone}>
          เบอร์ปัจจุบัน <strong className="ln-mono">{current}</strong>
        </p>
      </Card>

      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      <Card title="เปลี่ยนเบอร์">
        <Stack gap="md">
          <TextField
            id="newPhone"
            label="เบอร์ใหม่"
            inputMode="tel"
            autoComplete="tel"
            value={next}
            onChange={(event) => {
              setNext(event.target.value);
              setSent(false);
            }}
            help="เราจะส่งรหัสยืนยันไปที่เบอร์ใหม่นี้"
          />

          {!sent ? (
            <Button
              variant="secondary"
              icon="bell"
              loading={sending}
              disabled={normalised.length === 0}
              onClick={() => void sendCode()}
            >
              ส่งรหัสไปที่เบอร์ใหม่
            </Button>
          ) : (
            <>
              <TextField
                id="phoneCode"
                label="รหัสยืนยัน 6 หลัก"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button
                variant="primary"
                loading={saving}
                disabled={code.trim().length === 0}
                onClick={() => void confirm()}
              >
                ยืนยันและเปลี่ยนเบอร์
              </Button>
            </>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
