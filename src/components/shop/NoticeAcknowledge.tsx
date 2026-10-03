'use client';

/**
 * The privacy notice, shown at the moment a customer creates an account.
 *
 * **Why the notice is inlined here rather than only at `/privacy`.** A notice a customer
 * has to go and find is a notice most never read, and the shop's duty to inform is
 * discharged by the customer actually being told — not by a link existing somewhere.
 * So this is the notice itself, in the flow, at the one moment the shop can be certain
 * the reader is there.
 *
 * **Why the tick unlocks only at the end.** A checkbox that is live from the first
 * screenful records a click, not a reading. `canAcknowledge` opens when the notice has
 * been scrolled to its bottom, so what the row in `notice_acknowledgements` records is
 * "reached the end", which is the most this interface can honestly claim. It is a
 * courtesy, not a control — the server refuses a signup that names no current version
 * regardless of what the browser did (`identity.ts`), so a customer who skips this panel
 * is stopped one layer down rather than let through.
 *
 * **Why the scroll is detected and not merely scrollable.** A box that simply scrolls
 * invites the reader to flick it and tick the box, and the tick is what the shop keeps.
 * Watching for the end is four lines and turns "is there anything down there" into an
 * answer the interface gives rather than one the reader has to guess.
 *
 * **Why the box has a fixed height rather than growing.** A notice that fits on screen
 * would have no end to reach, and the gate would be a formality. `max-height` keeps the
 * gate meaningful and the door reachable on a phone, which is where a customer standing
 * at a counter actually is.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CUSTOMER_NOTICE_EFFECTIVE_FROM,
  CUSTOMER_NOTICE_PATH,
  hasReachedNoticeEnd,
  noticeEffectiveDateLabel,
} from '@/lib/privacy-notice';

import styles from './NoticeAcknowledge.module.css';

/**
 * The notice text, as a list of paragraphs.
 *
 * **A copy, and that is a deliberate cost.** The canonical notice is `/privacy`, and
 * this duplicates its substance — which is exactly the drift `offline-shell.test.ts`
 * refuses when it reads the shipped `public/sw.js` instead of a twin of it. It is here
 * anyway because rendering the page's server component inside a client flow would mean
 * either shipping the whole notice's stylesheet and layout for four paragraphs, or
 * fetching `/privacy` over the network and rendering someone else's markup into a form.
 *
 * So the duplication is fenced instead of prevented: `privacy-notice.test.ts` asserts
 * this panel and the page agree on the periods they both state (30 days, 5 minutes) and
 * on the effective date, which are the figures a customer would act on. If either side
 * changes one, the test fails rather than the shop quietly displaying two different
 * retention promises.
 */
const NOTICE_PARAGRAPHS: readonly string[] = [
  'ร้านเก็บชื่อ–นามสกุล และเบอร์โทรศัพท์ของคุณ เพื่อออกใบเสร็จและใบกำกับภาษี และเพื่อให้คุณดูประวัติการซื้อ ยอดแต้ม และเปิดใบเสร็จของตัวเองได้',
  'ร้านอาจใช้รหัสยืนยัน (OTP) ส่งไปยังเบอร์โทรของคุณ เพื่อยืนยันว่าเบอร์นั้นเป็นของคุณ โดยรหัสนี้หมดอายุภายใน 5 นาที',
  'เมื่อคุณสั่งซื้อล่วงหน้า ร้านจะส่งข้อความแจ้งเตือนผ่านช่องทางที่ร้านตั้งไว้ (LINE หรือ Webhook) เช่น เมื่อพรีออเดอร์พร้อมหรือแจ้งรหัสรับของ',
  'พนักงานที่ให้บริการเห็นเฉพาะชื่อและเบอร์โทรที่จำเป็นต่อการขาย และผู้จัดการเห็นข้อมูลสมาชิกของร้าน ระบบบันทึกการเข้าใช้งานไว้เพื่อตรวจสอบย้อนหลัง',
  'ใบเสร็จดาวน์โหลดได้ 30 วันนับจากวันที่ขาย หลังจากนั้นลิงก์จะปิด แต่ข้อมูลการขายไม่ถูกลบ รายการยังอยู่ในประวัติของคุณ',
  'ร้านไม่ขอเลขประจำตัวประชาชน ไม่ขอข้อมูลสุขภาพ ไม่ขอรูปบัตรประชาชน และไม่ขอเลขบัญชีธนาคารของคุณ',
  'คุณมีสิทธิขอดูหรือขอสำเนาข้อมูล ขอแก้ไข ขอให้ลบหรือทำให้เป็นข้อมูลที่ระบุตัวบุคคลไม่ได้ ขอจำกัดการใช้ ขอคัดลอกข้อมูล และคัดค้านการใช้ข้อมูลบางอย่าง กรุณาติดต่อที่หน้าเคาน์เตอร์',
];

export function NoticeAcknowledge({
  acknowledged,
  onChange,
}: {
  acknowledged: boolean;
  onChange: (next: boolean) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the notice has been read to its end. `useState` rather than a ref because
   * the checkbox's disabled state has to re-render — a ref would unlock the control
   * without telling React anything had changed.
   */
  const [reachedEnd, setReachedEnd] = useState(false);

  /**
   * Did the box reach its bottom?
   *
   * The arithmetic lives in `hasReachedNoticeEnd` as a pure function, because this is
   * the one number in the signup that decides whether a customer can tick a box, and a
   * boundary that can only be checked by dragging a real scroll container is a boundary
   * nobody will have checked.
   *
   * Set-once rather than set-both-ways: `reachedEnd` never goes back to false, so a
   * customer who reaches the end, scrolls back up to re-read a paragraph and comes back
   * down has not un-read anything.
   */
  const checkReachedEnd = useCallback(() => {
    const box = boxRef.current;
    if (box === null) {
      return;
    }
    if (hasReachedNoticeEnd(box.scrollTop, box.clientHeight, box.scrollHeight)) {
      setReachedEnd(true);
    }
  }, []);

  useEffect(() => {
    checkReachedEnd();
  }, [checkReachedEnd]);

  /*
   * A tick on an unread notice is withdrawn rather than left standing.
   *
   * The box can only be ticked once reached, so this is unreachable through the UI — it
   * is here because the notice can get *shorter* (a shop may shrink it, or the window
   * may be tall enough that the whole thing fits at once) and a tick taken against the
   * longer text should not survive the text changing under it.
   */
  useEffect(() => {
    if (!reachedEnd && acknowledged) {
      onChange(false);
    }
  }, [reachedEnd, acknowledged, onChange]);

  return (
    <div className={styles.panel}>
      <p className={styles.title}>
        นโยบายคุ้มครองข้อมูลส่วนบุคคล
        <span className={styles.effective}>
          {' '}
          มีผลตั้งแต่ {noticeEffectiveDateLabel(CUSTOMER_NOTICE_EFFECTIVE_FROM)}
        </span>
      </p>

      <div className={styles.box} ref={boxRef} onScroll={checkReachedEnd} tabIndex={0}>
        {NOTICE_PARAGRAPHS.map((paragraph) => (
          <p key={paragraph} className={styles.paragraph}>
            {paragraph}
          </p>
        ))}
        <p className={styles.paragraph}>
          อ่านฉบับเต็มและรายละเอียดการร้องเรียนต่อสคส. ได้ที่{' '}
          <a className={styles.link} href={CUSTOMER_NOTICE_PATH} target="_blank" rel="noreferrer">
            นโยบายฉบับเต็ม
          </a>
        </p>
      </div>

      <p className={styles.hint} aria-live="polite">
        {reachedEnd ? 'อ่านครบแล้ว' : 'เลื่อนลงจนถึงท้ายเพื่ออ่านให้จบ'}
      </p>

      <label className={styles.tick}>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={!reachedEnd}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>ยืนยันว่าคุณได้อ่านนโยบายคุ้มครองข้อมูลส่วนบุคคลแล้ว</span>
      </label>
    </div>
  );
}