'use client';

import { Button } from '@/components/ds';
import { Receipt, type ReceiptData } from '@/components/pos/Receipt';
import { receiptImageDataUrl } from '@/lib/receipt-image';
import type { ShopView } from '@/lib/shop-view';

import styles from './PublicReceipt.module.css';

/**
 * The receipt a customer holds, on the page their link opens (ADR 0021).
 *
 * The same document the till prints and the portal draws, from the same stored
 * snapshot — the point of the link is that the customer keeps the slip, so it must
 * be the slip, not a fresh calculation. Printing and the PNG download are here rather
 * than server-side because both are the *browser's* job: the print sheet is CSS, and
 * the image is drawn on a canvas by the renderer the Chromium journey proves.
 *
 * The action row carries `ln-no-print`, so the paper the customer prints is the
 * receipt and not the buttons that produced it.
 */
export function PublicReceipt({ shop, data }: { shop: ShopView; data: ReceiptData }) {
  function download(): void {
    const dataUrl = receiptImageDataUrl(shop, data);
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${data.orderNumber}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <main className={styles.page}>
      <div className={`${styles.actions} ln-no-print`}>
        <Button variant="secondary" icon="download" onClick={download}>
          ดาวน์โหลดรูปใบเสร็จ
        </Button>
        <Button variant="secondary" icon="print" onClick={() => window.print()}>
          พิมพ์
        </Button>
      </div>

      <Receipt shop={shop} data={data} when={data.createdAt} />
    </main>
  );
}
