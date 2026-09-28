'use client';

/**
 * Reprint a completed sale's receipt (ADR 0002).
 *
 * Renders with the same `Receipt` component the till uses at the moment of sale,
 * fed from the order's stored snapshot rather than from today's settings — so a
 * reprint is a copy of the document, not a fresh calculation that happens to
 * look similar.
 *
 * The dialog is the design system's `Overlay` rather than a hand-placed modal, so
 * Escape closes it, focus is trapped while it is open and handed back when it
 * closes, and the page behind it cannot scroll. A failure to load the receipt goes
 * to a toast, because the button that failed is a 34px control inside a table row
 * and there is nowhere next to it to put a paragraph.
 */
import { useState } from 'react';

import { Button, Overlay, useToast } from '@/components/ds';
import { Receipt, type ReceiptData } from '@/components/pos/Receipt';
import { apiFetch } from '@/lib/client-api';
import type { ShopView } from '@/lib/shop-view';

interface ReceiptPayload {
  shop: ShopView;
  receipt: ReceiptData;
}

export function ReceiptReprintButton({
  orderId,
  orderNumber,
}: {
  orderId: string;
  orderNumber: string;
}) {
  const toast = useToast();
  const [payload, setPayload] = useState<ReceiptPayload | null>(null);
  const [busy, setBusy] = useState(false);

  async function open(): Promise<void> {
    setBusy(true);
    try {
      setPayload(await apiFetch<ReceiptPayload>(`/api/v1/orders/${orderId}/receipt`));
    } catch (caught) {
      toast.show({
        tone: 'danger',
        title: 'เปิดใบเสร็จไม่สำเร็จ',
        body: caught instanceof Error ? caught.message : 'ลองใหม่อีกครั้ง',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        loading={busy}
        aria-label={`พิมพ์ใบเสร็จซ้ำของออเดอร์ ${orderNumber}`}
        onClick={() => void open()}
      >
        ใบเสร็จ
      </Button>

      <Overlay
        open={payload !== null}
        onClose={() => setPayload(null)}
        title={payload ? `ใบเสร็จของออเดอร์ ${payload.receipt.orderNumber}` : ''}
        footer={
          /*
           * The design system's `ln-no-print` hides this on the print sheet: a
           * reprint is something an operator hands to a customer, and the buttons
           * that opened it have no business appearing on the paper. It is the
           * last class in the JSX that used to come from the vendored theme.
           */
          <div className="ln-no-print">
            <Button variant="secondary" onClick={() => window.print()}>
              พิมพ์
            </Button>
            <Button variant="primary" onClick={() => setPayload(null)}>
              ปิด
            </Button>
          </div>
        }
      >
        {payload ? (
          <Receipt shop={payload.shop} data={payload.receipt} when={payload.receipt.createdAt} />
        ) : null}
      </Overlay>
    </>
  );
}
