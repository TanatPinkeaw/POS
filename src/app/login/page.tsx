import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { BrandMark } from '@/brand/BrandMark';
import { BRAND } from '@/brand/brand';
import { StaffDoorToggle } from '@/components/auth/StaffDoorToggle';
import { CustomerSignIn } from '@/components/shop/CustomerSignIn';
import { PrivacyScrim } from '@/components/shop/PrivacyScrim';
import { PrivacyNoticeBody } from '@/app/privacy/PrivacyNoticeBody';
import { getSessionUser } from '@/lib/auth';
import { readGoogleClientId } from '@/lib/google-id-token';
import { readLineChannelId } from '@/lib/line-id-token';
import { prisma } from '@/lib/db';
import { homePathForRole } from '@/lib/roles';
import { hasShop, loadShop } from '@/lib/shop';
import { shopDisplayName } from '@/lib/shop-view';

import styles from './customer-signin.module.css';

export const metadata: Metadata = { title: 'เข้าสู่ระบบ' };

/**
 * Demo accounts seeded by `npm run db:seed`.
 *
 * Rendered only inside the folded staff panel, never on the customer side of the
 * page: this is the front door customers arrive at (ADR 0029), and a table of staff
 * phone numbers printed above their heads is both noise to them and advertising to
 * anyone who should not be here. The block still renders only while the seeded
 * manager account exists, so it disappears on its own when a renter sets the system
 * up for real instead of having to remember to delete it.
 */
const DEMO_ACCOUNTS = [
  { role: 'ผู้จัดการ (Admin)', phone: '0800000001' },
  { role: 'แคชเชียร์ (Employee)', phone: '0800000002' },
  { role: 'พนักงานสต็อก (Employee)', phone: '0800000003' },
  { role: 'สมาชิก (Member)', phone: '0900000001' },
];

/**
 * The front door — and the front door is the customer's (ADR 0029).
 *
 * This page is where every path a person can be given leads: the domain root, the
 * proxy's refusals, `signOut`, the 404's escape link, bookmarks and printed QRs.
 * Until now it opened on a staff form, which made a customer's first screen a wall
 * of someone else's UI; the customer's own doors (ADR 0020) lived a second URL away
 * at `/shop`, which nothing in the app linked to. So the doors swapped places:
 * `CustomerSignIn` renders here, and the staff form folds behind `StaffDoorToggle`
 * below the card — reachable in one tap, but not the first thing a customer reads.
 *
 * `/shop` redirects here, so old links and QRs keep walking. The two routes share
 * `customer-signin.module.css`; only this one renders it.
 *
 * The Google client id and the LINE channel id are read here and passed down as
 * *values*: the screen shows every door, and each one knows whether it is
 * configured rather than loading a third-party script or firing a request to
 * find out. A door without its value renders as a sentence saying so — the shop
 * sees a closed door, not a broken one.
 */
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

  const contact = {
    name: shopDisplayName(shop),
    legalName: shop?.legalName ?? null,
    address: shop?.address ?? null,
    phone: shop?.phone ?? null,
  };

  return (
    /*
     * Touch density, because this screen is the customer's phone and the till
     * tablet alike. It sits outside every density scope — no session yet to tell
     * the two apart — so the larger sizes are the safe default for a screen that is
     * typed once and then left; the sub-16px field is what makes iOS Safari zoom
     * the viewport on focus and hide the button the customer was about to press.
     */
    <main className={styles.page} data-density="touch">
      <div className={styles.card}>
        <div className={styles.head}>
          {/*
           * Two identities, in order: the platform, then the shop. The customer
           * buying here is the shop's customer — but the software they are looking
           * at is ours, and this is the screen where that is most visible.
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

        <CustomerSignIn
          googleClientId={readGoogleClientId()}
          lineConfigured={readLineChannelId() !== null}
        />
      </div>

      {/*
       * The staff door renders *below the card*, not inside it: a customer scanning
       * the card must not have to read past anything about staff, and a member of
       * staff still finds their own door at the bottom of the page. The demo list
       * travels with it, inside the fold.
       */}
      <StaffDoorToggle>
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
      </StaffDoorToggle>

      <p className={styles.footer}>
        {BRAND.taglineEn}
        {' · '}
        {/*
          The door a customer walks in through is the one place they are told what the
          shop does with their phone number, which is the first moment a notice can be
          read by the person it is about (ADR 0020 collects a number and a name here).
          It opens as a scrim so reading it does not throw away a half-filled form.
        */}
        <PrivacyScrim shopName={shopDisplayName(shop)}>
          <PrivacyNoticeBody contact={contact} />
        </PrivacyScrim>
      </p>
    </main>
  );
}
