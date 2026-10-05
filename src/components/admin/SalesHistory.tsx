'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import {
  Button,
  Card,
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
  Toolbar,
  type Column,
} from '@/components/ds';
import { ApiError, apiFetch } from '@/lib/client-api';
import { bangkokDateTimeString } from '@/lib/bangkok-time';
import { Receipt } from '@/components/pos/Receipt';
import type { ReceiptData } from '@/components/pos/Receipt';
import type { OrderStatus } from '@/lib/order-state';
import type { ShopView } from '@/lib/shop-view';

import { ReceiptLinkDialog } from '@/components/pos/ReceiptLinkDialog';

import styles from './SalesHistory.module.css';

/**
 * The two statuses a completed sale can be in, in Thai.
 *
 * A history table is read by somebody looking for a specific document, so the
 * status is there to explain an anomaly rather than to carry meaning: a refunded row
 * that otherwise looks identical to a paid one is the only reason this column exists,
 * and it says so in a word rather than in a colour.
 */
const SALE_STATUS_LABEL: Record<string, string> = {
  completed: 'ปิดการขายแล้ว',
  refunded: 'คืนเงินแล้ว',
};

/** One sale, as the history table reads it. */
export interface SalesRow {
  id: string;
  orderNumber: string;
  receiptNumber: string | null;
  finalAmountThb: number;
  itemCount: number;
  customerName: string | null;
  completedAt: string | null;
  status: OrderStatus;
}

/**
 * Every sale the shop made, searchable by receipt number and day.
 *
 * **Search is a server round trip, not a filter over what is on screen.** That is
 * the one design decision here, and everything else follows from it. A client-side
 * filter would only ever see the fifty rows the server happened to send, so typing a
 * receipt number the shop printed last month would find nothing and say so with
 * confidence — which is worse than having no search at all, because it looks like an
 * answer. Every keystroke therefore goes through the URL, the server filters, and the
 * router pushes the new query; the back button and a shared link then both work, which
 * is what makes "send me the screen showing Tuesday" possible at all.
 *
 * The debounce is the only concession to typing speed. It is short enough that the
 * answer feels attached to the keystrokes and long enough that a ten-digit receipt
 * number is not ten requests.
 */
export function SalesHistory({
  initialRows,
  initialFrom,
  initialTo,
  initialReceiptNumber,
  initialCustomerName,
  initialOffset,
  pageSize,
  shop,
  canRefund,
}: {
  initialRows: SalesRow[];
  initialFrom: string;
  initialTo: string;
  initialReceiptNumber: string;
  initialCustomerName: string;
  initialOffset: number;
  pageSize: number;
  /** Only needed when a receipt is open; null keeps the document unrenderable. */
  shop: ShopView | null;
  canRefund: boolean;
}) {
  const router = useRouter();
  const [receiptNumber, setReceiptNumber] = useState(initialReceiptNumber);
  const [customerName, setCustomerName] = useState(initialCustomerName);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [pending, setPending] = useState(false);

  const [viewing, setViewing] = useState<{ order: SalesRow; receipt: ReceiptData } | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<{ orderId: string; orderNumber: string } | null>(
    null,
  );

  const search = useCallback(
    (overrides: Partial<{ receiptNumber: string; customerName: string; from: string; to: string; offset: number }> = {}) => {
      const next = { receiptNumber, customerName, from, to, offset: 0, ...overrides };
      const params = new URLSearchParams();
      if (next.receiptNumber.trim()) {
        params.set('receiptNumber', next.receiptNumber.trim());
      }
      if (next.customerName.trim()) {
        params.set('customerName', next.customerName.trim());
      }
      if (next.from) {
        params.set('from', next.from);
      }
      if (next.to) {
        params.set('to', next.to);
      }
      const query = params.toString();
      setPending(true);
      router.push(query === '' ? '/admin/sales' : `/admin/sales?${query}`);
    },
    [receiptNumber, customerName, from, to, router],
  );

  /** The same query with the page offset moved — the server owns the result set. */
  const goToOffset = (offset: number): void => {
    const params = new URLSearchParams();
    if (receiptNumber.trim()) {
      params.set('receiptNumber', receiptNumber.trim());
    }
    if (customerName.trim()) {
      params.set('customerName', customerName.trim());
    }
    if (from) {
      params.set('from', from);
    }
    if (to) {
      params.set('to', to);
    }
    if (offset > 0) {
      params.set('offset', String(offset));
    }
    setPending(true);
    router.push(`/admin/sales?${params.toString()}`);
  };

  const openReceipt = async (order: SalesRow): Promise<void> => {
    setViewError(null);
    try {
      const payload = await apiFetch<{ shop: ShopView; receipt: ReceiptData }>(
        `/api/v1/orders/${order.id}/receipt`,
      );
      setViewing({ order, receipt: payload.receipt });
    } catch (caught) {
      setViewError(
        caught instanceof ApiError ? caught.message : 'เปิดใบเสร็จไม่สำเร็จ',
      );
    }
  };

  const columns: Column<SalesRow>[] = [
    {
      key: 'receipt',
      header: 'เลขใบเสร็จ',
      cardLabel: 'เลขใบเสร็จ',
      /*
       * The order number stands in when there is no receipt number, which is every
       * sale of a shop that is not VAT registered — `receipt_number` belongs to the
       * tax document series and is null without one. Showing an em dash there gave an
       * owner a list of their own sales with no identifier on any of them, and the
       * search beside it could not find the number that column was hiding.
       */
      render: (row) => (
        <span className="ln-mono">{row.receiptNumber ?? row.orderNumber}</span>
      ),
    },
    {
      key: 'when',
      header: 'เวลาที่ขาย',
      cardLabel: 'เวลาที่ขาย',
      render: (row) =>
        row.completedAt ? bangkokDateTimeString(new Date(row.completedAt)) : '—',
    },
    {
      key: 'customer',
      header: 'ลูกค้า',
      cardLabel: 'ลูกค้า',
      render: (row) => row.customerName ?? 'ลูกค้าทั่วไป',
    },
    {
      key: 'items',
      header: 'รายการ',
      cardLabel: 'รายการ',
      align: 'end',
      render: (row) => String(row.itemCount),
    },
    {
      key: 'amount',
      header: 'ยอด',
      cardLabel: 'ยอด',
      align: 'end',
      render: (row) => <Money amount={row.finalAmountThb} />,
    },
    {
      key: 'status',
      header: 'สถานะ',
      cardLabel: 'สถานะ',
      render: (row) => <StatusPill status={row.status} label={SALE_STATUS_LABEL[row.status]} />,
    },
    {
      key: 'actions',
      header: '',
      cardLabel: '',
      render: (row) => (
        <span className="ln-row">
          <Button size="sm" variant="secondary" onClick={() => void openReceipt(row)}>
            ดูใบเสร็จ
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="qr"
            onClick={() =>
              setLinkTarget({ orderId: row.id, orderNumber: row.receiptNumber ?? row.orderNumber })
            }
          >
            ลิงก์
          </Button>
        </span>
      ),
    },
  ];

  const total = initialRows.length;
  /*
   * `offset + 1` is the first row's position, which is meaningless when the search
   * found nothing: an empty result used to read "แสดง 1–0", a range that starts past
   * where it ends and tells an owner the page is broken rather than empty. When there
   * is nothing to show, the count beside the title already says so.
   */
  const showingFrom = total === 0 ? 0 : initialOffset + 1;
  const showingTo = initialOffset + total;

  return (
    <Stack gap="md">
      <Toolbar
        actions={
          <Button
            variant="secondary"
            icon="search"
            loading={pending}
            onClick={() => search()}
          >
            ค้นหา
          </Button>
        }
      >
        <SearchField
          id="sales-receipt"
          label="เลขใบเสร็จ หรือเลขออเดอร์"
          placeholder="RC-2026-000042 หรือ POS-20261005-000009"
          value={receiptNumber}
          onChange={setReceiptNumber}
          onSubmit={() => search()}
          mono
        />
        <SearchField
          id="sales-customer"
          label="ชื่อลูกค้า"
          placeholder="ชื่อ–นามสกุล"
          value={customerName}
          onChange={setCustomerName}
          onSubmit={() => search()}
        />
        <TextField
          id="sales-from"
          label="ตั้งแต่วันที่"
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
        <TextField
          id="sales-to"
          label="ถึงวันที่"
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </Toolbar>

      {viewError ? <InlineNotice tone="danger">{viewError}</InlineNotice> : null}
      {pending ? <Spinner /> : null}

      <Card
        title="รายการขาย"
        actions={<Pill tone="info">{`${total} รายการ`}</Pill>}
        flush
        subtitle={`แสดง ${showingFrom}–${showingTo} · ช่วง ${initialFrom} ถึง ${initialTo}`}
      >
        <DataTable
          columns={columns}
          rows={initialRows}
          getRowKey={(row) => row.id}
          caption="ประวัติการขายที่ปิดการขายแล้ว"
          empty={
            <EmptyState
              icon="receipt"
              title="ไม่พบรายการขายในเงื่อนไขนี้"
              // The failure an owner actually hits is typing a number that exists but
              // sits outside the date box, so say that rather than just "no results".
              description={
                initialReceiptNumber || initialCustomerName
                  ? 'ลองขยายช่วงวันที่ หรือเช็กว่าสะกดเลขใบเสร็จ/เลขออเดอร์ถูกต้อง'
                  : 'ยังไม่มีการปิดการขายในช่วงวันที่เลือก'
              }
            />
          }
        />
      </Card>

      <div className={styles.pager}>
        <Button
          variant="secondary"
          disabled={initialOffset === 0 || pending}
          onClick={() => goToOffset(Math.max(0, initialOffset - pageSize))}
        >
          ก่อนหน้า
        </Button>
        <Button
          variant="secondary"
          disabled={total < pageSize || pending}
          onClick={() => goToOffset(initialOffset + pageSize)}
        >
          ถัดไป
        </Button>
      </div>

      {/*
        The document itself, in the same component the till prints from — so a
        reprint cannot disagree with the original by a field.
      */}
      <Overlay
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing ? `ใบเสร็จ ${viewing.order.receiptNumber ?? viewing.order.orderNumber}` : ''}
        description={
          viewing?.order.completedAt
            ? bangkokDateTimeString(new Date(viewing.order.completedAt))
            : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setViewing(null)}>
              ปิด
            </Button>
            <Button icon="print" onClick={() => window.print()}>
              พิมพ์ใบเสร็จซ้ำ
            </Button>
          </>
        }
      >
        {shop ? (
          <Receipt
            shop={shop}
            data={viewing?.receipt ?? ({} as ReceiptData)}
            {...(viewing?.order.completedAt ? { when: viewing.order.completedAt } : {})}
          />
        ) : null}
      </Overlay>

      {linkTarget ? (
        <ReceiptLinkDialog
          orderId={linkTarget.orderId}
          orderNumber={linkTarget.orderNumber}
          onClose={() => setLinkTarget(null)}
        />
      ) : null}
    </Stack>
  );
}