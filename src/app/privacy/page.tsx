import type { Metadata } from 'next';
import Link from 'next/link';

import { loadShop } from '@/lib/shop';
import { shopDisplayName } from '@/lib/shop-view';

import { PrivacyNoticeBody } from './PrivacyNoticeBody';
import styles from './privacy-page.module.css';

export const metadata: Metadata = {
  title: 'นโยบายคุ้มครองข้อมูลส่วนบุคคล · ลูกค้า',
  description: 'ร้านเก็บข้อมูลลูกค้าอะไร เก็บไว้ทำไม ใครเห็น และลูกค้ามีสิทธิอะไร',
};

/**
 * The shop's privacy notice **to its customers** — in Thai, at `/privacy`.
 *
 * **Why this is a page and not a document in `docs/`.** `docs/pdpa-research.md` found
 * that even a business exempt from the Act's record of processing is still expected to
 * publish a notice (the small-business exemption, B.E. 2565). A notice parked in a
 * repository is a notice no customer is ever shown; one rendered from the shop's own row
 * cannot go stale against the shop's own name, phone number or address.
 *
 * **Who it is for, and who it is about.** Two different parties meet in this document
 * and the Act insists they are named, because a notice that does not say who is
 * collecting whose data leaves the reader unable to hold anybody to it:
 *
 *   * the **shop** is the *controller* (ผู้ควบคุมข้อมูลส่วนบุคคล) — one shop per
 *     deployment, on hardware it controls (ADR 0002 §1), so the duties here are the
 *     shop's, not a promise this software makes on its own;
 *   * the **reader** is the *data subject* (เจ้าของข้อมูลส่วนบุคคล).
 *
 * So the page says "ร้าน" where it means the controller and "คุณ" where it means the
 * person reading, and never the other way round. That distinction is the whole reason
 * §3 is not titled "who we share with" — the shop is on one side of that sentence too.
 *
 * **Staff are not the reader, so their data is not here.** An earlier draft of this page
 * listed attendance records ("ข้อมูลการเข้า–ออกงาน") alongside purchase history, which
 * told a customer at the counter that the shop keeps a clock on its own employees — a
 * disclosure about somebody else's data, made to the wrong reader, in a document that
 * otherwise has to be the one thing a customer is *entitled* to read. Staff are data
 * subjects too, with their own notice: see `staff/page.tsx`. The overlap is real in the
 * schema — `users` is one table for both, and a person can be a member and a cashier in
 * the same row — but the *notice* is addressed to one reader at a time, so the two
 * pages list what that reader's own record contains and leave the rest out.
 *
 * **The numbers here are the defaults this code ships with**, which is the only kind a
 * notice can carry without being a lie: thirty days is `RECEIPT_ACCESS_DAYS`' default
 * (ADR 0021) and five minutes is `OTP_TTL_MINUTES`' default. Both are env-overridable,
 * so a shop that changes one is editing this page with the same commit. Where the
 * period is set by law rather than by us — invoices and tax documents — the notice says
 * so rather than inventing a figure this repository has not verified.
 *
 * **What it deliberately does not say.** No penalty paragraph, no reassurance about a
 * data protection officer, and no statement that a customer's data never leaves the
 * country — because "continue with Google" (ADR 0020) means it does, and the disclosure
 * is named in §4 instead.
 */
export default async function PrivacyPage() {
  const shop = await loadShop();
  // `shopDisplayName` rather than `shop?.name`: `loadShop` returns null before setup,
  // and an unconfigured `ShopView` carries `name: ''`, so reading the field directly
  // printed a blank line where a notice is required to name its controller. The
  // helper is the same one the sign-in door uses, so "who is this about" reads the
  // same on both pages.
  const contact = {
    name: shopDisplayName(shop),
    legalName: shop?.legalName ?? null,
    address: shop?.address ?? null,
    phone: shop?.phone ?? null,
  };

  return (
    <div className={styles.page}>
      <PrivacyNoticeBody contact={contact} />
    </div>
  );
}