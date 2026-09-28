'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { BrandMark } from '@/brand/BrandMark';
import { BRAND } from '@/brand/brand';
import styles from '@/design/brand-page.module.css';

/**
 * The error boundary for every route group.
 *
 * It is a client component by necessity — Next hands it the error and a `reset`
 * callback — so it cannot read the session or the shop. That is fine, and it is
 * the reason the brand is the only thing it shows: this page is what a shop sees
 * when something has gone wrong, and the useful things it can offer are "try
 * again", "go somewhere known", and the digest an operator can quote.
 *
 * The error text itself is never rendered. It may contain a database string or a
 * stack fragment, and a shop's screen is not the place for either; the digest is
 * the part that corresponds to a server log entry.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The browser console is the one place this belongs: a developer with the
    // page open gets the detail, and nobody else does.
    console.error('Unhandled error in a route:', error);
  }, [error]);

  return (
    <main className={styles.page}>
      <div className={styles.lockup}>
        <BrandMark size={34} />
        <span className={styles.lockupText}>
          <span className={styles.name}>{BRAND.nameTh}</span>
          <span className={styles.sub}>{BRAND.nameEn}</span>
        </span>
      </div>

      <div className={styles.card}>
        <p className={styles.code}>500</p>
        <h1 className={styles.title}>เกิดข้อผิดพลาดในระบบ</h1>
        <p className={styles.body}>
          ระบบทำงานขัดข้องในหน้านี้ ข้อมูลที่บันทึกไปแล้วไม่ได้รับผลกระทบ
          ลองอีกครั้งได้เลย หากยังไม่หาย ให้แจ้งผู้ดูแลระบบพร้อมรหัสอ้างอิงด้านล่าง
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.primaryAction} onClick={() => reset()}>
            ลองอีกครั้ง
          </button>
          <Link className={styles.secondaryAction} href="/">
            กลับหน้าแรก
          </Link>
        </div>
        {error.digest ? (
          <p className={styles.body}>
            รหัสอ้างอิง: <span className="ln-mono">{error.digest}</span>
          </p>
        ) : null}
      </div>

      <p className={styles.footer}>{BRAND.taglineTh}</p>
    </main>
  );
}
