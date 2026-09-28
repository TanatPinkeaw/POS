'use client';

/**
 * Reprint a completed sale's receipt (ADR 0002).
 *
 * Renders with the same `Receipt` component the till uses at the moment of sale,
 * fed from the order's stored snapshot rather than from today's settings — so a
 * reprint is a copy of the document, not a fresh calculation that happens to
 * look similar.
 */
import { useState } from 'react';

import { apiFetch } from '@/lib/client-api';
import type { ShopView } from '@/lib/shop-view';
import { Receipt, type ReceiptData } from '@/components/pos/Receipt';

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
  const [payload, setPayload] = useState<ReceiptPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function open(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      setPayload(await apiFetch<ReceiptPayload>(`/api/v1/orders/${orderId}/receipt`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'เปิดใบเสร็จไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-soft-secondary"
        disabled={busy}
        aria-label={`พิมพ์ใบเสร็จซ้ำของออเดอร์ ${orderNumber}`}
        onClick={() => void open()}
      >
        {busy ? '…' : 'ใบเสร็จ'}
      </button>

      {error && (
        <span className="text-danger small ms-2" role="alert" aria-live="assertive">
          {error}
        </span>
      )}

      {payload && (
        <div className="modal fade show d-block" role="dialog" aria-modal="true">
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <h2 className="modal-title h5">ใบเสร็จของออเดอร์ {payload.receipt.orderNumber}</h2>
                <button
                  type="button"
                  className="btn-close"
                  aria-label="ปิด"
                  onClick={() => setPayload(null)}
                />
              </div>
              <div className="modal-body">
                <Receipt
                  shop={payload.shop}
                  data={payload.receipt}
                  when={payload.receipt.createdAt}
                />
              </div>
              <div className="modal-footer no-print">
                <button
                  type="button"
                  className="btn btn-soft-secondary"
                  onClick={() => window.print()}
                >
                  พิมพ์
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setPayload(null)}>
                  ปิด
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
