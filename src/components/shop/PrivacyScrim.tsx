'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Button, Overlay } from '@/components/ds';

import styles from './PrivacyScrim.module.css';

/**
 * The privacy notice, as a scrim over the sign-in page.
 *
 * **Why it opens as an overlay rather than navigating.** The notice is a door a
 * customer is pointed at on the way *in*, and it used to be a `<Link>` that threw the
 * sign-in form away and put them on a different page. So a customer who wanted to
 * check what the shop does with their number had to read it, press Back, and start
 * the form again — and the overwhelmingly common reason to open a privacy notice is
 * to check something and carry on, which that flow makes as expensive as possible.
 * Reading it in place keeps the form's state, keeps the customer on the page they
 * chose, and makes the notice look like part of signing up rather than like being
 * sent away.
 *
 * **It is still a real route.** The trigger is a `<Link>` inside a `<button>`'s
 * sibling, not a `div` with a click handler, so `/privacy` remains reachable,
 * linkable and printable — the route audit depends on it, and so does anybody who
 * was sent the address. The scrim is the *convenience*; the page stays the
 * *canonical* document, and both render `PrivacyNoticeBody`, so they cannot say
 * different things.
 *
 * The notice itself arrives as `children` from the server, already rendered. It is
 * not fetched when the scrim opens, which is what keeps this from being a second
 * copy of the notice and what means it cannot be out of date by the time it is read.
 */
export function PrivacyScrim({
  children,
  shopName,
}: {
  children: ReactNode;
  /** Named in the dialog title, so the notice says who it is about before it is read. */
  shopName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/*
        The trigger is a link and the scrim is a button, side by side: a customer with
        JavaScript gets the overlay, and a customer without it — or a crawler, or
        somebody following the address out of a chat message — still gets the page.
      */}
      <span className={styles.trigger}>
        <Link href="/privacy" className={styles.link}>
          นโยบายคุ้มครองข้อมูลส่วนบุคคลสำหรับลูกค้า
        </Link>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          ดูในหน้านี้
        </Button>
      </span>

      <Overlay
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="นโยบายคุ้มครองข้อมูลส่วนบุคคล"
        description={`สำหรับลูกค้าของ ${shopName} · ใช้ได้ทั้งหน้านี้และที่ /privacy`}
        footer={
          <>
            <Link href="/privacy" className={styles.footerLink}>
              เปิดเป็นหน้าเต็ม
            </Link>
            <Button onClick={() => setOpen(false)}>ปิด</Button>
          </>
        }
      >
        {children}
      </Overlay>
    </>
  );
}