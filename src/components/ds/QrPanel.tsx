'use client';

import { useEffect, useState } from 'react';

import { formatCountdown, secondsRemaining, type PaymentIntentView } from '@/lib/payment-intents-view';

import styles from './QrPanel.module.css';

/**
 * The QR a customer scans, and the clock that says how long they have.
 *
 * Rendered from the payload the server built rather than assembled here: the
 * checksum, the normalised account number and the amount are money, and money is
 * built where it can be tested without a browser.
 *
 * The countdown is computed from the intent's own `expiresAt` on every tick rather
 * than counted down locally, so a screen that was asleep — which, on a shop
 * tablet, is most of them — shows the true remaining time the moment it wakes.
 */
export function QrPanel({
  intent,
  size = 240,
  onExpired,
}: {
  intent: PaymentIntentView;
  size?: number;
  /** Fired once when the clock reaches zero, so the caller can stop waiting. */
  onExpired?: () => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(() => secondsRemaining(intent));

  useEffect(() => {
    let cancelled = false;

    /*
     * `qrcode` is imported lazily: it is a few dozen kilobytes of encoder, it is
     * only ever needed on the two screens that show a QR, and pulling it into
     * every bundle would cost the till's first paint for nothing.
     */
    void import('qrcode').then(async (module) => {
      const url = await module.default.toDataURL(intent.qrPayload, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: size * 2,
        color: { dark: '#111827', light: '#ffffff' },
      });
      if (!cancelled) {
        setSource(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [intent.qrPayload, size]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = secondsRemaining(intent);
      setRemaining(left);
      if (left === 0) {
        onExpired?.();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [intent, onExpired]);

  return (
    <div className={styles.panel}>
      <div className={styles.frame} style={{ width: size, height: size }}>
        {source ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data URL from
          // the encoder, not a remote asset: `next/image` would add nothing and
          // cannot optimise it.
          <img src={source} alt={`พร้อมเพย์ ${intent.amountThb.toFixed(2)} บาท`} width={size} height={size} />
        ) : (
          <span className={styles.placeholder}>กำลังสร้าง QR…</span>
        )}
      </div>

      <p className={styles.amount}>{intent.amountThb.toFixed(2)} บาท</p>
      <p className={styles.ref}>
        รหัสอ้างอิง <strong>{intent.ref}</strong>
      </p>
      <p className={remaining > 0 ? styles.countdown : styles.expired} role="status">
        {remaining > 0 ? `เหลือเวลา ${formatCountdown(remaining)}` : 'QR หมดอายุแล้ว'}
      </p>
    </div>
  );
}
