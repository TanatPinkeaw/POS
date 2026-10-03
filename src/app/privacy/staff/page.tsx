import type { Metadata } from 'next';
import Link from 'next/link';

import { loadShop } from '@/lib/shop';
import { shopDisplayName } from '@/lib/shop-view';

import styles from '../privacy-page.module.css';

export const metadata: Metadata = {
  title: 'นโยบายคุ้มครองข้อมูลส่วนบุคคล · พนักงาน',
  description: 'ร้านเก็บข้อมูลพนักงานอะไร เก็บไว้ทำไม ใครเห็น และพนักงานมีสิทธิอะไร',
};

/**
 * The shop's privacy notice **to its staff** — in Thai, at `/privacy/staff`.
 *
 * **Why this is a separate page rather than a section of `/privacy`.** An earlier
 * version of the customer notice carried one line — attendance records, "เฉพาะกรณีที่คุณ
 * เป็นพนักงานของร้าน" — inside a list of purchase history. That told every customer
 * standing at the counter that the shop keeps a clock on its employees: a disclosure
 * about somebody else's data, made in a document the reader is entitled to, to the
 * wrong person. Attendance is the most personal record this system holds, because it
 * measures a person's day, and a customer has no standing to read it and no reason to
 * be told it exists.
 *
 * So the split is by *reader*, not by table. `users` is one table and a person can be a
 * member and a cashier in the same row (ADR 0011 opens accounts at the counter, and
 * consignment, ADR 0023, makes a member a seller), so the schema cannot separate them.
 * The notice can, and must: one page per data subject, each listing what *that* reader's
 * own record contains.
 *
 * **Who it is for.** The shop is the controller (ผู้ควบคุมข้อมูลส่วนบุคคล) — its
 * obligations as an employer, which is a heavier set than its obligations to a customer
 * and carries its own edges. The reader is an employee, who in Thai labour law is owed
 * more on a personnel record than a customer is on a purchase history, so §2 says which
 * obligations are the shop's own rather than a customer's contract.
 *
 * **What it deliberately does not say.** No claim that the shop never checks attendance,
 * and no figure for how long employment records live — that period is set by Thai labour
 * law and by a shop's own policy, neither of which this repository has verified, so §5
 * names the gap. Also nothing about a data protection officer, who is not required until
 * 100,000 data subjects (`docs/pdpa-research.md`).
 */
export default async function StaffPrivacyPage() {
  const shop = await loadShop();
  const contact = {
    name: shopDisplayName(shop),
    legalName: shop?.legalName ?? null,
    address: shop?.address ?? null,
    phone: shop?.phone ?? null,
  };

  return (
    <div className={styles.page}>
      <article className={styles.sheet}>
        <p className={styles.audience}>
          นโยบายนี้สำหรับ <strong>พนักงาน</strong> ของร้าน
        </p>
        <h1 className={styles.heading}>นโยบายคุ้มครองข้อมูลส่วนบุคคลสำหรับพนักงาน</h1>
        <p className={styles.parties}>
          <strong>ผู้ควบคุมข้อมูลส่วนบุคคล:</strong> {contact.legalName ?? contact.name}
          {contact.legalName ? ` (${contact.name})` : ''} — ในฐานะนายจ้างของคุณ
          ต่อไปในหน้านี้เรียกว่า “ร้าน”
          <br />
          <strong>เจ้าของข้อมูลส่วนบุคคล:</strong> คุณ — ผู้อ่านหน้านี้
        </p>
        <p className={styles.effective}>มีผลตั้งแต่ 3 ตุลาคม 2569</p>

        <p className={styles.body}>
          หน้านี้อธิบายว่าร้านเก็บข้อมูลเกี่ยวกับการทำงานของคุณอะไร เก็บไว้ทำไม
          ใครมีสิทธิ์เห็น และคุณมีสิทธิอะไรในฐานะพนักงาน
        </p>
        <p className={styles.body}>
          ถ้าคุณเป็น<strong>ลูกค้า</strong> และไม่ได้ทำงานที่ร้าน ให้ดู
          <Link href="/privacy" className={styles.inlineLink}>
            นโยบายสำหรับลูกค้า
          </Link>
          แทน ซึ่งจะไม่กล่าวถึงข้อมูลการทำงานของคุณเลย
        </p>

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>1. ข้อมูลพนักงานที่ร้านเก็บ</h2>
          <ul className={styles.list}>
            <li>ชื่อ–นามสกุล เบอร์โทรศัพท์ อีเมล และรหัสผ่านที่เข้ารหัสแล้ว</li>
            <li>รหัส PIN สำหรับผู้ดูแล และจำนวนครั้งที่ใส่ PIN ผิด</li>
            <li>
              <strong>ตารางเวลาทำงาน</strong> — เวลาเข้า–ออกงาน และชั่วโมงที่ทำงาน
              บันทึกทุกครั้งที่คุณสแกนเข้า–ออก
            </li>
            <li><strong>ตารางกะที่ร้านกำหนด</strong> — วันที่ เวลาเริ่ม เวลาจบ และหมายเหตุที่ผู้จัดการใส่</li>
            <li>
              <strong>กิจกรรมที่คุณทำในระบบ</strong> — บิลที่คุณเปิด ลิ้นชักที่คุณเปิดและปิด
              การยกเลิกบิลหรือการคืนเงิน และการให้ส่วนลดเกินลิมิตของร้าน
            </li>
            <li>
              <strong>ประวัติการเข้าใช้ระบบ</strong> — ใครทำอะไร เมื่อไหร่ และใครอนุมัติ
              รวมถึงเหตุการณ์ที่ระบบปฏิเสธ เช่น พยายามเข้าระบบผิดเกินจำนวนครั้งที่กำหนด
            </li>
          </ul>
          <p className={styles.notCollected}>
            <strong>สิ่งที่ร้านไม่ขอ:</strong> ไม่ขอเลขประจำตัวประชาชน ไม่ขอข้อมูลสุขภาพ
            ไม่ขอรูปบัตรประชาชน และไม่ขอข้อมูลการเมือง นอกจากนี้
            ข้อมูลที่คุณเปิดบัญชีเป็น<strong>ลูกค้า</strong>ของร้าน จะอยู่ในเอกสารของคุณในฐานะลูกค้า
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>2. ทำไมร้านจึงเก็บ</h2>
          <ul className={styles.list}>
            <li>
              <strong>เพื่อปฏิบัติตามสัญญาจ้างงาน</strong> — คำนวณเวลาทำงาน โบนัส และค่าจ้าง
              เป็นหน้าที่ตามสัญญาระหว่างร้านกับคุณ
            </li>
            <li>
              <strong>เพื่อจัดการเงินของร้านให้ถูกต้อง</strong> — เปิด–ปิดลิ้นชักต่อกะ
              และกระทบยอดเงินจริงของร้าน
            </li>
            <li>
              <strong>เพื่อป้องกันการทุจริต</strong> — การยกเลิกบิล การคืนเงิน หรือการให้ส่วนลดเกินลิมิต
              ต้องมีผู้อนุมัติ ระบบจึงบันทึกว่าใครทำอะไรและใครอนุมัติ
            </li>
            <li>
              <strong>เพื่อความปลอดภัยของบัญชี</strong> — จำกัดจำนวนครั้งที่ลองรหัสผ่านหรือ PIN
              เพื่อกันการเดารหัส
            </li>
          </ul>
          <p className={styles.body}>
            การเก็บข้อมูลเหล่านี้เป็น<strong>หน้าที่ของร้าน</strong>ตามสัญญาจ้างงานและเพื่อประโยชน์ของคุณเอง
            ร้านจึงไม่ได้อ้างการขอความยินยอมจากคุณ แต่ถ้าคุณไม่สแกนเข้า–ออกงาน
            ระบบจะไม่มีข้อมูลเวลาทำงานของคุณในวันนั้น
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>3. ใครมีสิทธิ์เห็นข้อมูลการทำงานของคุณ</h2>
          <ul className={styles.list}>
            <li>
              <strong>ผู้จัดการของร้าน</strong> — เห็นตารางเวลา ตารางกะ และกิจกรรมของพนักงานทุกคน
            </li>
            <li>
              <strong>พนักงานคนอื่น</strong> — เห็นข้อมูลของตัวเองเท่านั้น ไม่เห็นเวลาทำงานของคนอื่น
              เว้นแต่เป็นการดูข้อมูลลูกค้าที่ต้องให้บริการร่วมกัน
            </li>
            <li>
              <strong>คุณเอง</strong> — เห็นเวลาเข้า–ออกงาน ชั่วโมงทำงานสะสม และกิจกรรมของตัวเอง
            </li>
          </ul>
          <p className={styles.notCollected}>
            <strong>สิ่งที่ร้านไม่ทำ:</strong> ร้านไม่เปิดเผยข้อมูลการทำงานของคุณให้ลูกค้ารายอื่น
            และไม่ใช้ข้อมูลเวลาทำงานเพื่อการตลาดหรือการขายต่อ
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>4. มีการส่งข้อมูลให้บุคคลหรือองค์กรอื่นหรือไม่</h2>
          <p className={styles.body}>
            ร้านไม่ส่งข้อมูลการทำงานของคุณให้บุคคลหรือองค์กรอื่น
            ยกเว้นกรณีที่กฎหมายบังคับให้ต้องเปิดเผย เช่น หน่วยงานราชการหรือศาลที่มีอำนาจ
          </p>
          <p className={styles.body}>
            ช่องทางแจ้งเตือนของร้าน (LINE หรือ Webhook) ส่งข้อความเกี่ยวกับยอดขายของร้านเท่านั้น
            ไม่ได้ส่งข้อมูลการทำงานของพนักงานไปที่ใด
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>5. ร้านเก็บข้อมูลนี้ไว้นานเท่าไหร่</h2>
          <ul className={styles.list}>
            <li>
              <strong>เวลาเข้า–ออกงานและชั่วโมงทำงาน</strong> — เก็บไว้ตามระยะเวลาที่กฎหมายแรงงานกำหนด
              และตามนโยบายของร้าน ร้านควรแจ้งให้คุณทราบระยะเวลาที่ใช้จริง
            </li>
            <li>
              <strong>ประวัติการทำรายการขายที่คุณเปิด</strong> — เก็บตามระยะเวลาที่กฎหมายภาษีกำหนด
              เพราะเป็นเอกสารทางภาษีของร้าน
            </li>
            <li>
              <strong>ประวัติการเข้าใช้ระบบและการแก้ไขข้อมูลสำคัญ</strong> — เก็บไว้เพื่อให้ตรวจสอบย้อนหลังได้ว่าเกิดอะไรขึ้น
              โดยเฉพาะเมื่อมีข้อกล่าวหรือข้อโต้แย้งเรื่องเงิน
            </li>
            <li>
              <strong>รหัสยืนยัน (OTP)</strong> — หมดอายุภายใน 5 นาที และใช้ได้ครั้งเดียว
            </li>
          </ul>
          <p className={styles.body}>
            เมื่อคุณเลิกงาน ร้านจะเก็บข้อมูลที่ต้องเก็บไว้ตามกฎหมายไว้
            และลบบัญชีการใช้งานที่ไม่จำเป็นต่อไป พร้อมแจ้งให้คุณทราบว่าอะไรถูกเก็บและอะไรถูกลบ
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>6. สิทธิของคุณในฐานะพนักงาน</h2>
          <p className={styles.body}>
            คุณมีสิทธิต่อไปนี้ ทั้งตามกฎหมายคุ้มครองข้อมูลส่วนบุคคลและตามกฎหมายแรงงาน
          </p>
          <ul className={styles.list}>
            <li>ขอดูหรือขอสำเนาข้อมูลการทำงานของคุณ</li>
            <li>ขอแก้ไขข้อมูลที่ไม่ถูกต้อง เช่น เวลาเข้า–ออกงานที่บันทึกผิด</li>
            <li>ขอให้ลบข้อมูล หรือขอจำกัดการใช้ข้อมูลของคุณ</li>
            <li>ขอคัดลอกข้อมูลออกไปในรูปแบบที่เครื่องมืออัตโนมัติอ่านได้</li>
            <li>คัดค้านการใช้ข้อมูลบางอย่างของคุณ</li>
            <li>ถอนความยินยอม หากคุณเคยให้ไว้</li>
          </ul>
          <p className={styles.body}>
            ขอได้ที่ผู้จัดการของร้านโดยตรง หรือติดต่อร้านตามข้อมูลด้านล่าง
            ร้านจะดำเนินการโดยไม่ชักช้าและจะแจ้งเหตุผลให้ทราบ หากไม่สามารถทำได้
          </p>
          <p className={styles.body}>
            <strong>ข้อยกเว้น:</strong> เอกสารทางบัญชีและภาษี รวมถึงบิลที่คุณเปิด
            ต้องเก็บไว้ตามกฎหมาย แม้คุณจะขอให้ลบ ร้านจะลบเฉพาะส่วนที่ไม่ต้องเก็บตามกฎหมาย
            และจะแจ้งให้ทราบว่าอะไรถูกเก็บไว้และเพราะอะไร
          </p>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>7. ความปลอดภัยของข้อมูล</h2>
          <ul className={styles.list}>
            <li>รหัสผ่านและ PIN ถูกเข้ารหัสก่อนบันทึก ไม่ได้เก็บเป็นคำผ่านเปล่า</li>
            <li>การเข้าใช้งานทุกครั้งตรวจสอบสิทธิ์ตามตำแหน่ง ผู้จัดการหรือพนักงาน</li>
            <li>จำกัดจำนวนครั้งที่ลองรหัสผ่านและ PIN ป้องกันการเดารหัส</li>
            <li>ปฏิเสธ PIN อัตโนมัติหลังใส่ผิดติดต่อกันหลายครั้ง</li>
            <li>มีบันทึกว่าใครทำอะไร เมื่อไหร่ เพื่อให้ตรวจสอบย้อนหลังได้</li>
            <li>เข้าระบบผ่านการเชื่อมต่อที่เข้ารหัส (HTTPS)</li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionHeading}>8. ติดต่อผู้ควบคุมข้อมูล และร้องเรียน</h2>
          <p className={styles.contact}>
            <strong>ผู้ควบคุมข้อมูลส่วนบุคคล (นายจ้าง)</strong>
            <br />
            {contact.legalName ?? contact.name}
            {contact.legalName ? ` (${contact.name})` : ''}
            {contact.address ? (
              <>
                <br />
                {contact.address}
              </>
            ) : null}
            {contact.phone ? (
              <>
                <br />
                โทร. {contact.phone}
              </>
            ) : null}
          </p>
          <p className={styles.body}>
            หากร้านไม่ปฏิบัติตามนโยบายนี้ คุณสามารถร้องเรียนต่อผู้จัดการของร้านก่อน
            หากยังไม่ได้ผล สามารถร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล (สคส.)
            ได้ที่ <strong>pdpc.or.th</strong>
          </p>
        </section>
      </article>
    </div>
  );
}