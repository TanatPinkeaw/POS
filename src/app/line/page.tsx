import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { BrandMark } from '@/brand/BrandMark';
import { BRAND } from '@/brand/brand';
import { LiffEntry } from '@/components/shop/LiffEntry';
import { getSessionUser } from '@/lib/auth';
import { readLiffId } from '@/lib/line-liff-entry';
import { homePathForRole } from '@/lib/roles';
import { loadShop } from '@/lib/shop';
import { shopDisplayName } from '@/lib/shop-view';

import styles from './line-entry.module.css';

export const metadata: Metadata = { title: 'เข้าสู่ระบบด้วย LINE' };

/**
 * `/line` — the LIFF app's endpoint URL (ADR 0032 §1).
 *
 * A customer arrives here from a link in the shop's own chat, inside LINE's browser, with
 * their LINE account already open. The page's job is to hand that to `LiffEntry`, which
 * turns it into the member session every other customer screen already uses and then sends
 * them to `/shop/products`, where they would have landed by any other door.
 *
 * **Rendered per request, and that is not decoration.** The entry calls LINE and posts an id
 * token minted for *this* browser; a cached copy would be served to the next customer with
 * the first one's state baked in — the same failure `dynamic = 'force-dynamic'` prevents on
 * `/login`, where the state is minted into the LINE button's own href.
 *
 * **Public, deliberately.** There is no session yet — that is what this page exists to
 * create — so it is listed in `isPublicPath` beside `/login`, `/setup` and `/display`. What
 * protects it is not the list: the id token has to be genuinely LINE's, verified in process
 * against this deployment's channel (`line-id-token.ts`), and the account it names has to be
 * one of this shop's customers.
 */
export const dynamic = 'force-dynamic';

export default async function LineEntryPage() {
  /*
   * A customer who already has a session is sent where the session earns rather than shown
   * an entry that would replace it: pressing a link in a chat must not sign anybody *out*,
   * and a member opening their own shop's link has nothing to prove.
   */
  const session = await getSessionUser();
  if (session) {
    redirect(homePathForRole(session.role));
  }

  const liffId = readLiffId();
  const shop = await loadShop();

  return (
    /*
     * Touch density, like the front door: this screen is a phone in a customer's hand, and
     * it sits outside every density scope because there is no session to tell the areas
     * apart yet.
     */
    <main className={styles.page} data-density="touch">
      <div className={styles.card}>
        <div className={styles.head}>
          <BrandMark size={46} title={BRAND.nameTh} />
          <p className={styles.brand}>
            {BRAND.nameTh} · {BRAND.nameEn}
          </p>
          <h1 className={styles.shop}>{shopDisplayName(shop)}</h1>
          <p className={styles.tagline}>เข้าสู่ระบบด้วยบัญชี LINE ของคุณ</p>
        </div>

        <LiffEntry configured={liffId !== null} liffId={liffId} />
      </div>

      <p className={styles.footer}>{BRAND.taglineEn}</p>
    </main>
  );
}
