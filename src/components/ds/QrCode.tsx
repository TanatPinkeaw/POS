'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * A payload rendered as a QR.
 *
 * The two things this project turns into a QR are both money-adjacent — the
 * PromptPay code a customer pays, and the handover code that releases a parcel —
 * so they share one encoder call rather than two that can drift apart in size,
 * error correction or quiet zone. A QR with too small a margin still scans on a
 * phone held still and fails on a shop tablet, which is the kind of difference
 * nobody notices until a customer is waiting.
 *
 * `qrcode` is imported lazily: it is a few dozen kilobytes of encoder, it is only
 * ever needed on the screens that show a code, and pulling it into every bundle
 * would cost the till's first paint for nothing.
 */
export function QrCode({
  value,
  size = 240,
  alt,
  placeholder,
}: {
  value: string;
  /** Rendered CSS pixels; the encoder is asked for twice that for a crisp retina. */
  size?: number;
  alt: string;
  /** Shown while the encoder loads, so a panel can say what it is doing. */
  placeholder?: ReactNode;
}) {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void import('qrcode').then(async (module) => {
      const url = await module.default.toDataURL(value, {
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
  }, [value, size]);

  /*
   * The space is held while the encoder loads, so a panel that appears mid-sale
   * does not shove the rest of the screen down when it arrives.
   */
  if (!source) {
    return placeholder ? (
      <div style={{ width: size, height: size }}>{placeholder}</div>
    ) : (
      <div style={{ width: size, height: size }} aria-hidden="true" />
    );
  }

  return (
    <img
      src={source}
      width={size}
      height={size}
      alt={alt}
      style={{ display: 'block', width: size, height: size }}
    />
  );
}
