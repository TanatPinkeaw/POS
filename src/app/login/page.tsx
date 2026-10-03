import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { BrandMark } from '@/brand/BrandMark';
import { BRAND } from '@/brand/brand';
import { LoginForm } from '@/components/auth/LoginForm';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { homePathForRole } from '@/lib/roles';
import { hasShop, loadShop } from '@/lib/shop';
import { shopDisplayName } from '@/lib/shop-view';

import styles from './login.module.css';

export const metadata: Metadata = { title: 'เข้าสู่ระบบ' };

/**
 * Demo accounts seeded by `npm run db:seed`.
 *
 * Listed on the sign-in card on purpose: having the three roles one tap away is
 * what makes the RBAC behaviour easy to check. The block renders only while the
 * seeded manager account still exists, so it disappears on its own when a renter
 * sets the system up for real instead of having to remember to delete it.
 */
const DEMO_ACCOUNTS = [
  { role: 'ผู้จัดการ (Admin)', phone: '0800000001' },
  { role: 'แคชเชียร์ (Employee)', phone: '0800000002' },
  { role: 'พนักงานสต็อก (Employee)', phone: '0800000003' },
  { role: 'สมาชิก (Member)', phone: '0900000001' },
];

export default async function LoginPage() {
  const session = await getSessionUser();
  if (session) {
    redirect(homePathForRole(session.role));
  }

  /*
   * Before setup there are no accounts at all, so signing in is impossible and
   * this page is a dead end. Sending the visitor to the wizard is the whole
   * difference between "a fresh deployment" and "a broken one".
   */
  if (!(await hasShop())) {
    redirect('/setup');
  }

  const shop = await loadShop();

  /*
   * The demo accounts are a development aid, not a feature. They are listed only
   * while the seeded manager account still exists, so a renter who never ran the
   * seed never sees them advertised on their own sign-in page.
   */
  const seedAccountExists =
    (await prisma.users.count({ where: { phone: DEMO_ACCOUNTS[0]?.phone ?? '0800000001' } })) > 0;

  return (
    /*
     * Touch density, because the same door is the till's.
     *
     * This page sits outside every density scope, so it took the desk's sizes for
     * everyone: 14px fields in 34px controls, the size at which iOS Safari zooms the
     * viewport on focus. The people who reach it are not all at a desk — a cashier
     * signs in on the till tablet, which is the same touch density the selling screen
     * runs at — and there is no session yet to tell the two apart, so the larger sizes
     * are the safe default for a screen that is typed once and then left.
     */
    <main className={styles.page} data-density="touch">
      <div className={styles.card}>
        <div className={styles.head}>
          {/*
           * Two identities, in order: the platform, then the shop. The person
           * signing in works at the shop — but the software they are looking at
           * is ours, and this is the screen where that is most visible.
           */}
          <BrandMark size={46} title={BRAND.nameTh} />
          <p className={styles.brand}>
            {BRAND.nameTh} · {BRAND.nameEn}
          </p>
          {/*
           * `<h1>` is the shop's name, not the brand's: a screen reader user
           * arriving here should hear which shop they are signing in to.
           */}
          <h1 className={styles.shop}>{shopDisplayName(shop)}</h1>
          <p className={styles.tagline}>{BRAND.taglineTh}</p>
        </div>

        <LoginForm />

        {seedAccountExists ? (
          <div className={styles.demo}>
            <p className={styles.demoTitle}>
              บัญชีทดลอง — รหัสผ่านทั้งหมดคือ <code className={styles.code}>password123</code>
            </p>
            <ul className={styles.demoList}>
              {DEMO_ACCOUNTS.map((account) => (
                <li key={account.phone} className={styles.demoRow}>
                  <span>{account.role}</span>
                  <code className={styles.demoPhone}>{account.phone}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <p className={styles.footer}>{BRAND.taglineEn}</p>
    </main>
  );
}
