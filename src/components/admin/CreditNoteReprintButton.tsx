'use client';

/**
 * Reprint a credit note (ADR 0004).
 *
 * The mirror of `ReceiptReprintButton`, and deliberately built the same way: the
 * same `CreditNote` component the till shows the instant a refund commits, fed
 * from the document's stored snapshot rather than from the sale it reversed. A
 * reprint of a credit note that quietly recomputed its figures from today's VAT
 * rate would be a different document wearing the same number, which is the one
 * thing a numbered document must never become.
 *
 * A failure goes to a toast, because this is a small control inside a table row
 * with nowhere beside it to put a paragraph.
 */
import { useState } from 'react';

import { Button, Overlay, useToast } from '@/components/ds';
import { CreditNote } from '@/components/pos/CreditNote';
import { apiFetch } from '@/lib/client-api';
import type { CreditNoteDocument } from '@/lib/credit-note-view';
import type { ShopView } from '@/lib/shop-view';

interface CreditNotePayload {
  shop: ShopView;
  creditNote: CreditNoteDocument;
}

export function CreditNoteReprintButton({
  orderId,
  orderNumber,
}: {
  orderId: string;
  orderNumber: string;
}) {
  const toast = useToast();
  const [payload, setPayload] = useState<CreditNotePayload | null>(null);
  const [busy, setBusy] = useState(false);

  async function open(): Promise<void> {
    setBusy(true);
    try {
      setPayload(await apiFetch<CreditNotePayload>(`/api/v1/orders/${orderId}/credit-note`));
    } catch (caught) {
      toast.show({
        tone: 'danger',
        title: 'เปิดใบลดหนี้ไม่สำเร็จ',
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
        aria-label={`พิมพ์ใบลดหนี้ของออเดอร์ ${orderNumber}`}
        onClick={() => void open()}
      >
        ใบลดหนี้
      </Button>

      <Overlay
        open={payload !== null}
        onClose={() => setPayload(null)}
        title={payload ? `ใบลดหนี้ ${payload.creditNote.documentNumber}` : ''}
        footer={
          <div className="ln-no-print">
            <Button variant="secondary" icon="print" onClick={() => window.print()}>
              พิมพ์
            </Button>
            <Button variant="primary" onClick={() => setPayload(null)}>
              ปิด
            </Button>
          </div>
        }
      >
        {payload ? <CreditNote shop={payload.shop} data={payload.creditNote} /> : null}
      </Overlay>
    </>
  );
}
