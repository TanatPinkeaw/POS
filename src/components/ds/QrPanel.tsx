'use client';

import { useEffect, useState } from 'react';

import { formatCountdown, secondsRemaining, type PaymentIntentView } from '@/lib/payment-intents-view';

import { QrCode } from './QrCode';
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
  const [remaining, setRemaining] = useState(() => secondsRemaining(intent));

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
        <QrCode
          value={intent.qrPayload}
          size={size}
          alt={`พร้อมเพย์ ${intent.amountThb.toFixed(2)} บาท`}
          placeholder={<span className={styles.placeholder}>กำลังสร้าง QR…</span>}
        />
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
