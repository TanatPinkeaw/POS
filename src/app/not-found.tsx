import type { Metadata } from 'next';
import Link from 'next/link';

import { BrandMark } from '@/brand/BrandMark';
import { BRAND } from '@/brand/brand';
import styles from '@/design/brand-page.module.css';

export const metadata: Metadata = { title: 'ไม่พบหน้านี้' };

/**
 * 404.
 *
 * Next serves this for any unmatched path, which includes a mistyped URL and a
 * deep link to a screen the signed-in role cannot reach. It deliberately offers
 * no "you may be looking for" list: this app's navigation is role-dependent, and
 * a server component cannot know which role is asking.
 */
export default function NotFound() {
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
        <p className={styles.code}>404</p>
        <h1 className={styles.title}>ไม่พบหน้าที่ต้องการ</h1>
        <p className={styles.body}>
          ที่อยู่นี้อาจพิมพ์ผิด หรือหน้านี้ถูกย้ายไปแล้ว
          หากคุณเข้าสู่ระบบอยู่ ลองกลับไปที่หน้าแรกของบทบาทคุณ
        </p>
        <div className={styles.actions}>
          <Link className={styles.primaryAction} href="/">
            กลับหน้าแรก
          </Link>
          <Link className={styles.secondaryAction} href="/login">
            เข้าสู่ระบบ
          </Link>
        </div>
      </div>

      <p className={styles.footer}>{BRAND.taglineTh}</p>
    </main>
  );
}
