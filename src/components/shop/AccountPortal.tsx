'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

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
  TextAreaField,
  TextField,
} from '@/components/ds';
import { useRealtimeEvent } from '@/components/realtime/RealtimeProvider';
import type { ReceiptData } from '@/components/pos/Receipt';
import { ApiError, apiFetch, apiPatch, apiPost } from '@/lib/client-api';
import { MAX_OFFER_DOCUMENTS, MAX_OFFER_PHOTOS } from '@/lib/consignment-rules';
import { formatThb } from '@/lib/money';
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

interface ConsignmentItem {
  productId: string;
  name: string;
  sharePercent: number;
  onHandQty: number;
  soldQty: number;
  refundedQty: number;
  earnedThb: number;
}

interface ConsignmentEntry {
  id: string;
  kind: 'sale' | 'refund' | 'payout';
  description: string | null;
  amountThb: number;
  at: string;
  payoutId: string | null;
}

interface ConsignmentPage {
  balanceThb: number;
  items: ConsignmentItem[];
  entries: ConsignmentEntry[];
}

/**
 * The customer's own account — points, receipts, consignment and their number
 * (ADR 0020, ADR 0021, ADR 0025).
 *
 * Panels behind one tab list, because they are questions about one account and a
 * member on a phone should not walk through several screens to answer them. Every call
 * is to a route that scopes by the session, so "another customer's data" is unreachable
 * by construction rather than by this component checking.
 *
 * The phone panel is the one that *acts*: the number is the identity, so changing it
 * sends a code to the **new** number and the change only lands once that code comes
 * back (ADR 0020 §5). The server owns that rule — the form simply shows both steps.
 */
export function AccountPortal({
  phone,
  pointsBalance,
  line,
}: {
  phone: string;
  pointsBalance: number;
  line: LineBindingView;
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
          { key: 'consignment', label: 'ฝากขาย' },
          { key: 'phone', label: 'เบอร์โทรศัพท์' },
          { key: 'line', label: 'LINE' },
        ]}
      />

      {tab === 'points' ? <PointsPanel /> : null}
      {tab === 'receipts' ? <ReceiptsPanel /> : null}
      {tab === 'consignment' ? (
        // The offer form and the queue in front of the money, in the same tab rather
        // than new ones: the member came here to see where their consignment stands,
        // and the way to send more of the same goods is on the same screen (ADR 0025).
        <Stack gap="lg">
          <ConsignmentOfferForm />
          <ConsignmentOfferPanel />
          <ConsignmentPanel />
        </Stack>
      ) : null}
      {tab === 'phone' ? <PhonePanel phone={phone} /> : null}
      {tab === 'line' ? <LinePanel line={line} /> : null}
    </Stack>
  );
}

/* --------------------------------------------------------------------- line */

/** What the server sent about this customer's LINE, as one card's worth of facts. */
export interface LineBindingView {
  lineSubject: string | null;
  consentAt: string | null;
  consentVersion: string | null;
}

/**
 * The LINE card (ADR 0030): what is bound, what is consented, and the two acts
 * that change either.
 *
 * The tab is a tab and not a section of เบอร์โทรศัพท์ because the two answer
 * different questions — the phone is *who you are*, LINE is *where the shop may
 * reach you* — and because a member looking for "ทำไมไม่ได้รับแจ้งเตือน" should
 * find one place whose whole subject is that.
 *
 * Two states the page renders honestly:
 *
 *   * **Bound and consented** — the card says so, and offers the withdrawal.
 *     Withdrawing clears both facts (the strongest form of stop), so the button
 *     says exactly that rather than dressing it up as a pause.
 *   * **Not bound** — the card explains the two halves (ผูกบัญชี, then เพิ่มเพื่อน)
 *     because the friend condition is real: the shop's Official Account must be
 *     added before a push can arrive, and a customer who consented but never
 *     added the shop would otherwise be told the shop is ignoring them.
 */
function LinePanel({ line }: { line: LineBindingView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [binding, setBinding] = useState(line);

  /*
   * The callback redirect lands here with `?line=bound` (or `=error` / `=session`),
   * so the card re-reads its own state from the server after the redirect — the
   * server component re-renders on `router.refresh()`, but the props it passed down
   * were serialised before this client component mounted on the old page. Reading
   * once on mount keeps the card from showing yesterday's binding.
   */
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get('line') === null) {
      return;
    }
    window.history.replaceState(null, '', '/shop/account');
    void (async () => {
      try {
        setBinding(await apiFetch<LineBindingView>('/api/v1/account/line'));
        router.refresh();
      } catch {
        // The card keeps what it was given; a retry is one reload away.
      }
    })();
  }, [router]);

  async function unbind(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/v1/account/line', { unlink: true });
      setBinding({ lineSubject: null, consentAt: null, consentVersion: null });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'ยกเลิกการผูกไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  async function reconsent(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/v1/account/line', { consentOnly: true });
      setBinding((current) => ({ ...current, consentAt: new Date().toISOString() }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'บันทึกการยินยอมไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  const masked = binding.lineSubject
    ? `U${'•'.repeat(6)}${binding.lineSubject.slice(-4)}`
    : null;

  return (
    <Stack gap="md">
      <Card title="บัญชี LINE" subtitle="ที่ที่ร้านส่งแจ้งเตือนพรีออเดอร์ให้คุณ">
        <Stack gap="md">
          {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

          {binding.lineSubject === null ? (
            <>
              <p className="ln-muted">
                ผูกบัญชี LINE เพื่อรับแจ้งเตือน "สินค้าพร้อมรับ" ทาง LINE ของคุณเอง แทนที่จะต้องเปิดหน้าเว็บดู
              </p>
              <Button
                variant="primary"
                icon="link"
                loading={busy}
                onClick={() => {
                  window.location.href = '/api/v1/auth/line/authorize';
                }}
              >
                ผูกบัญชี LINE
              </Button>
              <p className="ln-muted ln-text-sm">
                เปิดหน้ายืนยันของ LINE แล้วกลับมาที่หน้านี้ — คุณยังใช้เบอร์โทรและ Google เข้าได้เหมือนเดิม
              </p>
            </>
          ) : (
            <>
              <p className={styles.currentPhone}>
                ผูกกับบัญชี LINE <strong className="ln-mono">{masked}</strong>
              </p>
              {binding.consentAt ? (
                <InlineNotice tone="success" title="รับการแจ้งเตือนทาง LINE">
                  ยืนยันไว้เมื่อ {new Date(binding.consentAt).toLocaleString('th-TH')} —
                  อย่าลืมเพิ่มเพื่อนร้านใน LINE ด้วย มิฉะนั้นข้อความจะส่งไม่ถึง
                </InlineNotice>
              ) : (
                <Button variant="secondary" loading={busy} onClick={() => void reconsent()}>
                  ยินยอมรับการแจ้งเตือนทาง LINE
                </Button>
              )}
              <Button variant="ghost" loading={busy} onClick={() => void unbind()}>
                ยกเลิกการผูกและหยุดรับการแจ้งเตือน
              </Button>
            </>
          )}
        </Stack>
      </Card>
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

/* ------------------------------------------------------------- consignment */

/**
 * The member's own consignment position (ADR 0023).
 *
 * The same three figures the owner pays against, read through the member's session:
 * what the shop owes (`balanceThb` — the ledger's own sum), the goods they have left
 * with the shop (and how much of each has sold), and every movement, newest first. A
 * payout is a `payout` line and reads as a settled statement; a refund is a `refund`
 * line and reads as a reversal. A member who has consigned nothing gets the empty
 * state rather than an empty card, because "nothing yet" and "something went wrong"
 * must not look alike.
 */
function ConsignmentPanel() {
  const [page, setPage] = useState<ConsignmentPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(await apiFetch<ConsignmentPage>('/api/v1/consignment'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'โหลดข้อมูลฝากขายไม่สำเร็จ');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // A sale or refund moves this ledger, so it is worth refreshing with the orders.
  useRealtimeEvent(REALTIME_EVENTS.orderUpdated, useCallback(() => void load(), [load]));

  if (page === null && error === null) {
    return <Spinner />;
  }

  const hasItems = page !== null && page.items.length > 0;
  const hasEntries = page !== null && page.entries.length > 0;

  return (
    <Stack gap="md">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {page ? (
        <Card
          title="ยอดค้างจ่ายฝากขาย"
          subtitle="ส่วนแบ่งจากสินค้าที่คุณฝากร้านขาย"
          actions={
            <Pill tone={page.balanceThb > 0 ? 'success' : 'neutral'} icon="coins">
              <Money amount={page.balanceThb} />
            </Pill>
          }
        >
          <p className="ln-muted">
            ส่วนแบ่งคิดจากยอดขายสุทธิ (ไม่รวม VAT) ตามเปอร์เซ็นต์ที่ตกลงไว้ — ร้านจะโอนหรือจ่ายจาก
            ลิ้นชักให้คุณ พร้อมใบสำคัญทุกครั้ง
          </p>
        </Card>
      ) : null}

      {page && !hasItems && !hasEntries ? (
        <Card>
          <EmptyState
            icon="box"
            title="ยังไม่มีสินค้าฝากขาย"
            description="เมื่อคุณฝากสินค้ากับร้านและร้านขายได้ ยอดส่วนแบ่งจะแสดงที่นี่"
          />
        </Card>
      ) : null}

      {page && hasItems ? (
        <Card title="สินค้าที่ฝากขาย" subtitle="ส่วนแบ่ง · คงเหลือ · ขายแล้ว">
          <ul className={styles.ledger}>
            {page.items.map((item) => (
              <li key={item.productId} className={styles.ledgerRow}>
                <div className={styles.ledgerMain}>
                  <span className={styles.ledgerWhat}>{item.name}</span>
                  <span className="ln-muted">
                    ส่วนแบ่ง {item.sharePercent}% · คงเหลือ {item.onHandQty} · ขายแล้ว {item.soldQty}
                    {item.refundedQty > 0 ? ` · คืน ${item.refundedQty}` : ''}
                  </span>
                </div>
                <div className={styles.ledgerFigures}>
                  <Money amount={item.earnedThb} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {page && hasEntries ? (
        <Card title="ความเคลื่อนไหว" subtitle="ใหม่สุดก่อน">
          <ul className={styles.ledger}>
            {page.entries.map((entry) => (
              <li key={entry.id} className={styles.ledgerRow}>
                <div className={styles.ledgerMain}>
                  <span className={styles.ledgerWhat}>
                    {entry.description ?? CONSIGNMENT_KIND_LABEL[entry.kind]}
                  </span>
                  <span className="ln-muted">{new Date(entry.at).toLocaleString('th-TH')}</span>
                </div>
                <div className={styles.ledgerFigures}>
                  <Money amount={entry.amountThb} signed />
                  {entry.kind === 'payout' ? (
                    <Pill tone="success" icon="check">
                      จ่ายแล้ว
                    </Pill>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Stack>
  );
}

/** The fallback wording for a movement whose description is missing. */
const CONSIGNMENT_KIND_LABEL: Record<ConsignmentEntry['kind'], string> = {
  sale: 'ยอดขาย',
  refund: 'คืนสินค้า',
  payout: 'จ่ายเงิน',
};

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

/**
 * The "re-read my offers" callback, owned by the module rather than passed down.
 *
 * The form and the list are two sibling panels in one tab, so lifting this into React
 * context or hoisting them into a parent would both be ceremony for exactly one call.
 * A module-level binding with a no-op default is what lets the form call it before the
 * list has ever mounted, and what makes an unmounted list impossible to write to. There
 * is one consignment tab on one page, so there is exactly one of these.
 */
let offerReload: () => void = noop;

function noop(): void {}

/**
 * A member offering their own goods for consignment (ADR 0025).
 *
 * The whole intake, on the member's own account page: four fields, a list of links,
 * and a send button. There is no shop to configure, no form to publish and no third
 * party in the middle — a member who wants to leave a tray of things with the shop
 * fills this in, and the row lands in the owner's inbox on `/admin/consignors`.
 *
 * Three things about the shape are deliberate:
 *
 *   * **The photo fields take links, not files.** The shop keeps its pictures in a
 *     Nextcloud folder and pastes links (ADR 0014); a member's photos live wherever
 *     they live, and this deployment holds no files it could back up. So the form asks
 *     for a URL the same way an operator pastes one, and says so under the field rather
 *     than failing a member who tried to attach a 4 MB phone picture.
 *   * **The member's phone is never asked for.** They are signed in, and the session
 *     names them. The old Google Form asked for a number and had to cope with it not
 *     matching anybody; here that whole failure mode does not exist.
 *   * **The send button mints its own idempotency key.** `clientRef` is generated once
 *     per filled form (the same idea as the offline till's `clientRef`, ADR 0019), so a
 *     double tap or a retried request is one offer rather than two — see the unique
 *     index in the migration.
 */
function ConsignmentOfferForm() {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [photoLinks, setPhotoLinks] = useState<AttachmentDraft[]>([]);
  const [docLinks, setDocLinks] = useState<AttachmentDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /*
   * One key per form, minted when the panel first draws and again after every
   * successful send. It is deliberately *not* minted inside `send`: a member who taps
   * twice has to produce one offer, and a key generated per tap would make two.
   */
  const clientRef = useRef<string>(newOfferKey());

  const priceNumber = Number(price);
  const qtyNumber = Number(quantity);
  const canSend =
    name.trim() !== '' &&
    price !== '' &&
    Number.isFinite(priceNumber) &&
    priceNumber >= 0 &&
    quantity !== '' &&
    Number.isInteger(qtyNumber) &&
    qtyNumber > 0 &&
    !saving;

  function reset(): void {
    setName('');
    setPrice('');
    setQuantity('1');
    setNotes('');
    setPhotoLinks([]);
    setDocLinks([]);
    setError(null);
    setDone(false);
    // A fresh form is a fresh offer, so it gets a fresh key.
    clientRef.current = newOfferKey();
  }

  async function send(): Promise<void> {
    if (!canSend) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost('/api/v1/consignment/submissions', {
        clientRef: clientRef.current,
        productName: name.trim(),
        offeredPriceThb: priceNumber,
        quantity: qtyNumber,
        notes: notes.trim() ? notes.trim() : null,
        photos: photoLinks.map((link) => ({ label: link.label.trim(), url: link.url.trim() })),
        documents: docLinks.map((link) => ({ label: link.label.trim(), url: link.url.trim() })),
      });
      // The queue beside this form should show the new row without a manual refresh.
      offerReload();
      reset();
      setDone(true);
    } catch (caught) {
      // The server's own message, so "a URL that cannot open" reads as that.
      setError(caught instanceof ApiError ? caught.message : 'ส่งคำขอไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title="ฝากขายสินค้ากับร้าน"
      subtitle="กรอกรายการที่ต้องการฝากขาย ร้านจะตรวจสอบและแจ้งผลในหน้านี้"
    >
      <Stack gap="md">
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        {done && !error ? (
          <InlineNotice tone="success" title="ส่งคำขอแล้ว">
            ร้านจะตรวจสอบและแจ้งผลในหน้านี้ ถ้าต้องการฝากขายเพิ่ม กรอกรายการใหม่ได้เลย
          </InlineNotice>
        ) : null}

        <TextField
          id="offer-name"
          label="ชื่อสินค้า"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="เช่น ขนมปังถังโบราณ"
        />

        <div className={styles.offerRow}>
          <TextField
            id="offer-price"
            label="ราคาที่ต้องการขาย (บาท)"
            inputMode="decimal"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          <TextField
            id="offer-quantity"
            label="จำนวน (ชิ้น)"
            inputMode="numeric"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </div>

        <TextAreaField
          id="offer-notes"
          label="รายละเอียดเพิ่มเติม"
          help="เช่น สภาพสินค้า วันที่สะดวกมาส่ง หรือเงื่อนไขอื่นที่ร้านควรทราบ"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />

        <AttachmentList
          id="offer-photos"
          kind="photo"
          legend="รูปสินค้า (ลิงก์)"
          help="วางลิงก์รูปที่เปิดดูได้จากที่ไหนก็ได้ (เช่น Google Drive, Google Photos) — ร้านจะดูรูปนี้ตอนตรวจสอบ"
          value={photoLinks}
          onChange={setPhotoLinks}
        />

        <AttachmentList
          id="offer-docs"
          kind="document"
          legend="เอกสาร (ลิงก์)"
          help="เช่น ใบสำรองราคา ใบรับประกัน หรือรูปใบเสร็จ — ถ้าไม่มีก็ข้ามไว้ได้"
          value={docLinks}
          onChange={setDocLinks}
        />

        <Button icon="upload" loading={saving} disabled={!canSend} onClick={() => void send()}>
          ส่งคำขอฝากขาย
        </Button>
      </Stack>
    </Card>
  );
}

/**
 * One link the member is adding, still being typed.
 *
 * Draft state rather than a submitted array, because a half-typed URL is not an
 * attachment and sending one as an attachment would put an error on the member's own
 * screen instead of in the field they are looking at. Blank rows are dropped on send.
 */
interface AttachmentDraft {
  label: string;
  url: string;
}

/**
 * The key one offer is sent under.
 *
 * A UUID from the browser, which is what makes the double-tap argument in the
 * component above work: the same key twice is the same offer to the server, and a new
 * key is minted only when the member starts a genuinely new one. `crypto.randomUUID`
 * is available in every browser this app supports, and the offline till uses the same
 * call for the same reason (ADR 0019).
 */
function newOfferKey(): string {
  return crypto.randomUUID();
}

/**
 * A repeatable list of link fields.
 *
 * "Add another" rather than a fixed set of empty inputs, because a member offering
 * handmade goods may have one photograph or nine, and a form that always shows eight
 * empty URL boxes is a form most people fill in wrongly. The cap matches the schema's
 * (`MAX_OFFER_PHOTOS` / `MAX_OFFER_DOCUMENTS`) so the button disappears rather than
 * letting the server refuse a ninth row.
 */
function AttachmentList({
  id,
  kind,
  legend,
  help,
  value,
  onChange,
}: {
  id: string;
  kind: 'photo' | 'document';
  legend: string;
  help: string;
  value: AttachmentDraft[];
  onChange: (next: AttachmentDraft[]) => void;
}) {
  const cap = kind === 'photo' ? MAX_OFFER_PHOTOS : MAX_OFFER_DOCUMENTS;

  function update(index: number, field: 'label' | 'url', next: string): void {
    onChange(value.map((row, i) => (i === index ? { ...row, [field]: next } : row)));
  }

  function add(): void {
    onChange([...value, { label: '', url: '' }]);
  }

  function remove(index: number): void {
    onChange(value.filter((_, i) => i !== index));
  }

  /*
   * Rows the member has not filled in are dropped rather than sent empty, so "I added a
   * row and changed my mind" cannot become a validation error on their own screen.
   */
  const filled = value.filter((row) => row.url.trim() !== '');

  return (
    <fieldset className={styles.attachments}>
      <legend className={styles.attachmentsLegend}>{legend}</legend>
      <p className="ln-muted ln-text-sm">{help}</p>

      {value.map((row, index) => (
        <div key={index} className={styles.attachmentRow}>
          <TextField
            id={`${id}-${index}-url`}
            label={kind === 'photo' ? `ลิงก์รูปที่ ${index + 1}` : `ลิงก์เอกสารที่ ${index + 1}`}
            inputMode="url"
            value={row.url}
            onChange={(event) => update(index, 'url', event.target.value)}
            placeholder="https://..."
          />
          <TextField
            id={`${id}-${index}-label`}
            label="คำอธิบาย (ถ้ามี)"
            value={row.label}
            onChange={(event) => update(index, 'label', event.target.value)}
          />
          <Button variant="ghost" onClick={() => remove(index)}>
            ลบ
          </Button>
        </div>
      ))}

      {filled.length === 0 && value.length === 0 ? (
        <Button variant="secondary" onClick={add}>
          เพิ่มลิงก์
        </Button>
      ) : null}
      {value.length > 0 && value.length < cap ? (
        <Button variant="secondary" onClick={add}>
          เพิ่มลิงก์อีก
        </Button>
      ) : null}
    </fieldset>
  );
}

/**
 * The member's own offers: what they sent and what the shop said (ADR 0025).
 *
 * Kept as its own panel above the balance rather than folded into it, because the two
 * answer different questions: "what have you earned" is settled money, while this is
 * the queue in front of it. A member whose offer was refused can read exactly what the
 * shop said here, and that has nothing to do with what the shop owes them.
 *
 * Photographs are shown as links to open rather than drawn. They live on whatever file
 * host the member kept them on, and a member's account page is not the place to quietly
 * pull a gallery of thumbnails from somebody else's server; the label is what matters,
 * and the link is there for when it does.
 */
function ConsignmentOfferPanel() {
  const [rows, setRows] = useState<MemberSubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await apiFetch<MemberSubmission[]>('/api/v1/consignment/submissions'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'โหลดคำขอฝากขายไม่สำเร็จ');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Lets the form above ask this panel to re-read after a successful send, so a member
   * sees their new row appear rather than having to reload the page to discover whether
   * the send worked. Registered in an effect, never during render, so the callback is
   * always the current `load` rather than the one captured on the first draw.
   */
  useEffect(() => {
    offerReload = load;
    return () => {
      offerReload = noop;
    };
  }, [load]);

  if (rows !== null && rows.length === 0) {
    return (
      <Stack gap="md">
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        <EmptyState
          title="ยังไม่มีคำขอฝากขาย"
          description="กรอกแบบฟอร์มด้านบนเพื่อส่งรายการที่ต้องการฝากขาย ร้านจะแจ้งผลในหน้านี้"
        />
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      {rows === null && error === null ? <Spinner /> : null}

      {rows?.map((row) => (
        <Card
          key={row.id}
          title={row.productName}
          subtitle={`ส่งเมื่อ ${new Date(row.submittedAt).toLocaleString('th-TH')} · ${row.quantity} ชิ้น · ${formatThb(row.offeredPriceThb)}`}
          actions={<Pill tone={SUBMISSION_TONE[row.status]}>{SUBMISSION_STATUS_LABEL[row.status]}</Pill>}
        >
          <Stack gap="sm">
            {row.status === 'rejected' && row.decisionNote ? (
              <InlineNotice tone="warning" title="ร้านตอบว่า">
                {row.decisionNote}
              </InlineNotice>
            ) : null}

            {row.status === 'approved' && row.decidedSharePercent !== null ? (
              <p className="ln-muted">
                ตกลงส่วนแบ่ง {row.decidedSharePercent}% ของยอดสุทธิต่อชิ้นที่ขายได้
                {row.decisionNote ? ` · หมายเหตุ: ${row.decisionNote}` : ''}
              </p>
            ) : null}

            {row.documents.length > 0 ? (
              <ul className={styles.ledger}>
                {row.documents.map((document) => (
                  <li key={document.id}>
                    <a href={document.url} target="_blank" rel="noreferrer">
                      {document.label}
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </Stack>
        </Card>
      ))}
    </Stack>
  );
}

/** One offer as the member's own account reads it. */
interface MemberSubmission {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  productName: string;
  offeredPriceThb: number;
  quantity: number;
  decidedSharePercent: number | null;
  decisionNote: string | null;
  submittedAt: string;
  documents: { id: string; label: string; url: string }[];
}

/**
 * The three states a member can be in, in the shop's words.
 *
 * "รอตรวจสอบ" rather than anything about the share, because the share has not been
 * discussed yet — the member has offered goods and the shop has not answered. Saying
 * "pending terms" would name a conversation that has not happened.
 */
const SUBMISSION_STATUS_LABEL: Record<MemberSubmission['status'], string> = {
  pending: 'รอร้านตรวจสอบ',
  approved: 'รับไว้แล้ว',
  rejected: 'ไม่ได้รับ',
};

/**
 * The pill tone per state, spelled out because the design system's `Tone` is internal
 * to its own module: a screen states the three colours it needs rather than importing
 * a vocabulary that exists to serve fifteen components.
 */
const SUBMISSION_TONE: Record<
  MemberSubmission['status'],
  'neutral' | 'success' | 'warning' | 'danger'
> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};
