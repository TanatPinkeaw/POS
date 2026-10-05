'use client';

import { useEffect, useState } from 'react';

import { Button, InlineNotice, Overlay, QrCode } from '@/components/ds';
import { apiPost } from '@/lib/client-api';

import styles from './ReceiptLinkDialog.module.css';

interface MintedLink {
  token: string;
  /** The API path the token resolves to; the customer is sent the page instead. */
  path: string;
}

/**
 * Hand a walk-in their receipt link (ADR 0021 §3).
 *
 * The counter's half of the signed link, and the surface ticket 06 left out: until
 * now the mint route existed and nothing showed it. A cashier opens this from the
 * receipt they are already looking at, and it **mints a fresh link on every open** —
 * reissue rather than reuse, so a link shown to one customer is never a standing key
 * to the order, and a screenshot of a previous one stops working once its short life
 * ends.
 *
 * The QR encodes the **page** the customer opens (`/receipts?t=…`), not the JSON API
 * path the server returns: the link is handed over to be *seen*, so it points at the
 * page that draws the receipt. The URL is spelled out beside it for anyone reading it
 * down a phone, and the whole panel prints — the buttons do not, by `ln-no-print`.
 */
export function ReceiptLinkDialog({
  orderId,
  orderNumber,
  onClose,
}: {
  orderId: string;
  orderNumber: string;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [apiPath, setApiPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const minted = await apiPost<MintedLink>(`/api/v1/orders/${orderId}/receipt-link`, {});
        if (cancelled) {
          return;
        }
        // The customer's page, on this shop's own origin — the server does not know
        // which host a till is reached on, so the browser supplies it.
        setToken(minted.token);
        setApiPath(minted.path);
        setUrl(`${window.location.origin}/receipts?t=${encodeURIComponent(minted.token)}`);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'สร้างลิงก์ไม่สำเร็จ');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  async function copy(): Promise<void> {
    if (url === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // A clipboard the browser refuses (an insecure origin, a locked-down kiosk) is
      // not worth an error: the URL is on screen to be read or selected by hand.
      setCopied(false);
    }
  }

  /*
   * The customer screen is cleared on the way out: a receipt QR left standing
   * after the dialog closes is a link the next customer in line can scan, and
   * this dialog mints a fresh link per open — the screen must not outlive it.
   */
  const close = (): void => {
    if (onScreen && token !== null && apiPath !== null) {
      void apiPost('/api/v1/pos/display/receipt', null).catch(() => {
        // Fire-and-forget like the cart post: the screen replaces this with the
        // next sale's facts, and a till must not hang on a screen in the corner.
      });
    }
    onClose();
  };

  async function showOnScreen(): Promise<void> {
    if (token === null || apiPath === null) {
      return;
    }
    setScreenError(null);
    try {
      await apiPost('/api/v1/pos/display/receipt', {
        orderNumber,
        token,
        path: apiPath,
      });
      setOnScreen(true);
    } catch (caught) {
      setScreenError(caught instanceof Error ? caught.message : 'ส่งขึ้นจอลูกค้าไม่สำเร็จ');
    }
  }

  return (
    <Overlay
      open
      onClose={close}
      title={`ลิงก์ใบเสร็จ · ${orderNumber}`}
      description="ให้ลูกค้าสแกนหรือเปิดลิงก์นี้ — ลิงก์มีอายุจำกัดและใช้ได้ภายใน 1 เดือนหลังการซื้อ"
      footer={
        <div className="ln-no-print">
          <Button variant="secondary" icon="print" disabled={url === null} onClick={() => window.print()}>
            พิมพ์
          </Button>
          <Button variant="secondary" icon="monitor" disabled={url === null || onScreen} onClick={() => void showOnScreen()}>
            {onScreen ? 'ขึ้นจอแล้ว' : 'ขึ้นจอลูกค้า'}
          </Button>
          <Button variant="primary" onClick={close}>
            ปิด
          </Button>
        </div>
      }
    >
      {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}

      {!error && url === null ? <p className={styles.loading}>กำลังสร้างลิงก์…</p> : null}

      {url !== null ? (
        <div className={styles.panel}>
          <div className={styles.frame}>
            <QrCode value={url} size={220} alt={`ลิงก์ใบเสร็จของบิล ${orderNumber}`} />
          </div>
          <p className={styles.hint}>สแกนด้วยกล้องมือถือเพื่อเปิดใบเสร็จ</p>
          <p className={`ln-mono ${styles.url}`}>{url}</p>
          <div className={`${styles.copyRow} ln-no-print`}>
            <Button variant="secondary" size="sm" icon="copy" onClick={() => void copy()}>
              {copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์'}
            </Button>
          </div>
          {screenError ? (
            <p className={styles.hint} role="alert">
              {screenError}
            </p>
          ) : null}
          {onScreen ? (
            <p className={styles.hint}>แสดงบนจอลูกค้าแล้ว — ปิดหน้าต่างนี้เพื่อเอาออกจากจอ</p>
          ) : null}
        </div>
      ) : null}
    </Overlay>
  );
}
