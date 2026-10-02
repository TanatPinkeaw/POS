import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { BrandMark } from '@/brand/BrandMark';
import { BRAND } from '@/brand/brand';
import { CustomerSignIn } from '@/components/shop/CustomerSignIn';
import { getSessionUser } from '@/lib/auth';
import { readGoogleClientId } from '@/lib/google-id-token';
import { homePathForRole } from '@/lib/roles';
import { hasShop, loadShop } from '@/lib/shop';
import { shopDisplayName } from '@/lib/shop-view';

import styles from './shop-signin.module.css';

export const metadata: Metadata = { title: 'เข้าสู่ระบบลูกค้า' };

/**
 * The customer's door (ADR 0020 §3).
 *
 * `/shop` itself is public — the one screen in the shop area a person with no
 * account reaches, because it is how they get one. A visitor who already has a
 * session is sent to their own home rather than shown a sign-in they do not need,
 * and a shop that has not been set up sends them to the wizard, so neither state is
 * a dead end.
 *
 * The Google client id is read here and passed down as a *value*: the screen shows
 * both doors, and the Google one knows whether it is configured rather than loading
 * a third-party script to find out.
 */
export default async function ShopSignInPage() {
  const session = await getSessionUser();
  if (session) {
    redirect(homePathForRole(session.role));
  }

  if (!(await hasShop())) {
    redirect('/setup');
  }

  const shop = await loadShop();

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <div className={styles.head}>
          <BrandMark size={46} title={BRAND.nameTh} />
          <p className={styles.brand}>
            {BRAND.nameTh} · {BRAND.nameEn}
          </p>
          <h1 className={styles.shop}>{shopDisplayName(shop)}</h1>
          <p className={styles.tagline}>{BRAND.taglineTh}</p>
        </div>

        <CustomerSignIn googleClientId={readGoogleClientId()} />
      </div>

      <p className={styles.footer}>{BRAND.taglineEn}</p>
    </main>
  );
}
