'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ds';
import { Receipt, type ReceiptData } from '@/components/pos/Receipt';
import { receiptImageDataUrl } from '@/lib/receipt-image';
import {
  browserReceiptCapabilities,
  receiptSaveAction,
  type ReceiptSaveAction,
} from '@/lib/receipt-save';
import type { ShopView } from '@/lib/shop-view';

import styles from './PublicReceipt.module.css';

/**
 * The receipt a customer holds, on the page their link opens (ADR 0021).
 *
 * The same document the till prints and the portal draws, from the same stored
 * snapshot — the point of the link is that the customer keeps the slip, so it must
 * be the slip, not a fresh calculation. Printing and the PNG are here rather than
 * server-side because both are the *browser's* job: the print sheet is CSS, and the
 * image is drawn on a canvas by the renderer the Chromium journey proves.
 *
 * **How the picture leaves this page is decided by the browser, not by this screen**
 * (`receipt-save.ts`, ADR 0034). A walk-in scanning the counter's QR is very often
 * inside LINE, and LINE's in-app browser ignores an `<a download>` without telling
 * anybody: the old button was a tap that produced nothing, on a page whose only other
 * action is a print sheet the host app may not have either. So: share the file when the
 * share sheet takes one; download where there is a download manager; and, where neither
 * exists, draw the PNG on the page and say the one thing that works — press and hold,
 * save to photos.
 *
 * The action row carries `ln-no-print`, so the paper the customer prints is the
 * receipt and not the buttons that produced it.
 */
export function PublicReceipt({ shop, data }: { shop: ShopView; data: ReceiptData }) {
  /**
   * Probed after mount, because the decision reads `navigator` and `File` — neither of
   * which exists while this page is rendered on the server. `null` until then, so the
   * action row simply is not drawn on the first paint rather than guessing wrongly.
   */
  const [action, setAction] = useState<ReceiptSaveAction | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const next = receiptSaveAction(browserReceiptCapabilities());
    setAction(next);
    /*
     * Only the last resort draws the picture up front: a customer who can share or
     * download does not need a second copy of the slip on the same page, and drawing one
     * costs a canvas and a data URL on their data plan's device.
     */
    if (next === 'long-press') {
      setImageUrl(receiptImageDataUrl(shop, data, data.createdAt));
    }
  }, [shop, data]);

  async function save(): Promise<void> {
    if (action === null || action === 'long-press') {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const dataUrl = receiptImageDataUrl(shop, data, data.createdAt);
      if (action === 'share') {
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.share({
          files: [new File([blob], `${data.orderNumber}.png`, { type: 'image/png' })],
          title: `ใบเสร็จ ${data.orderNumber}`,
        });
        setNotice('แชร์ใบเสร็จแล้ว — เลือก “บันทึกไปยังรูปภาพ” หรือ “บันทึกไปยังไฟล์”');
      } else {
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${data.orderNumber}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setNotice('บันทึกรูปใบเสร็จแล้ว');
      }
    } catch (caught) {
      // A cancelled share is the customer changing their mind, not a failure.
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setNotice('บันทึกไม่สำเร็จ — กดค้างที่รูปเพื่อบันทึกแทนได้');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={`${styles.actions} ln-no-print`}>
        {action === 'share' ? (
          <Button variant="secondary" icon="share" loading={saving} onClick={() => void save()}>
            แชร์ / บันทึก
          </Button>
        ) : null}
        {action === 'download' ? (
          <Button variant="secondary" icon="download" loading={saving} onClick={() => void save()}>
            ดาวน์โหลดรูปใบเสร็จ
          </Button>
        ) : null}
        <Button variant="secondary" icon="print" onClick={() => window.print()}>
          พิมพ์
        </Button>
      </div>

      {notice ? <p className={styles.notice}>{notice}</p> : null}

      <Receipt shop={shop} data={data} when={data.createdAt} />

      {action === 'long-press' && imageUrl !== null ? (
        <div className={`${styles.imageBlock} ln-no-print`}>
          <p className={styles.hint}>
            เบราว์เซอร์นี้บันทึกไฟล์เองไม่ได้ — กดค้างที่รูปด้านล่างแล้วเลือก
            “บันทึกไปยังรูปภาพ”
          </p>
          <img
            className={styles.image}
            src={imageUrl}
            alt={`รูปใบเสร็จ ${data.orderNumber}`}
          />
        </div>
      ) : null}

      {/*
        The walk-in's only route to the shop's notice, and the one that matters: a customer
        who never made an account and never gave a phone number still holds a document
        built from their purchase, and this is the page that carries it. `ln-no-print` with
        the buttons, so a printed slip stays a slip.
      */}
      <p className={`${styles.privacy} ln-no-print`}>
        <Link href="/privacy">นโยบายคุ้มครองข้อมูลส่วนบุคคลสำหรับลูกค้า</Link>
      </p>
    </main>
  );
}
