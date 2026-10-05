import Link from 'next/link';

import {
  CUSTOMER_NOTICE_EFFECTIVE_FROM,
  noticeEffectiveDateLabel,
} from '@/lib/privacy-notice';

import styles from './privacy-page.module.css';

/**
 * The notice itself, with no page around it.
 *
 * Split out of `page.tsx` so `/privacy` and the scrim on `/shop` render **one**
 * document. The failure this avoids is specific and bad: a notice copied into a
 * second file is a notice that says one thing to a customer who opens the link and
 * another to a customer who reads it in the overlay — and the version that drifts is
 * always the one nobody edits, because nobody remembers it exists.
 *
 * A server component on purpose. The sign-in page is already rendered on the server,
 * and a notice that is *rendered* rather than *fetched* cannot be stale by the time it
 * is shown, cannot render somebody else's markup into the form, and costs no request
 * when a customer opens it.
 */
const EFFECTIVE_FROM = noticeEffectiveDateLabel(CUSTOMER_NOTICE_EFFECTIVE_FROM);

export interface NoticeContact {
  name: string;
  legalName: string | null;
  address: string | null;
  phone: string | null;
}

export function PrivacyNoticeBody({ contact }: { contact: NoticeContact }) {
  return (
  <article className={styles.sheet}>
    <p className={styles.audience}>
      นโยบายนี้สำหรับ <strong>ลูกค้า</strong> ของร้าน
    </p>
    <h1 className={styles.heading}>นโยบายคุ้มครองข้อมูลส่วนบุคคล</h1>
    <p className={styles.parties}>
      <strong>ผู้ควบคุมข้อมูลส่วนบุคคล:</strong> {contact.legalName ?? contact.name}
      {contact.legalName ? ` (${contact.name})` : ''} — ต่อไปในหน้านี้เรียกว่า “ร้าน”
      <br />
      <strong>เจ้าของข้อมูลส่วนบุคคล:</strong> คุณ — ผู้อ่านหน้านี้
    </p>
    <p className={styles.effective}>มีผลตั้งแต่ {EFFECTIVE_FROM}</p>

    <p className={styles.body}>
      หน้านี้อธิบายว่าร้านเก็บข้อมูลของคุณอะไร เก็บไว้ทำไม ใครมีสิทธิ์เห็น
      และคุณมีสิทธิอะไร ร้านเก็บเฉพาะที่จำเป็นต่อการขายและการให้บริการหลังการขาย
      ไม่มีการขายหรือเปิดเผยข้อมูลของคุณเพื่อการตลาด
    </p>
    <p className={styles.body}>
      หากคุณเป็น<strong>พนักงานของร้าน</strong> ให้ดู
      <Link href="/privacy/staff" className={styles.inlineLink}>
        นโยบายสำหรับพนักงาน
      </Link>
      แทน เพราะข้อมูลที่ร้านเก็บเกี่ยวกับการทำงานของคุณอยู่ในนโยบายนั้น
    </p>

    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>1. ข้อมูลลูกค้าที่ร้านเก็บ</h2>
      <ul className={styles.list}>
        <li>ชื่อ–นามสกุล และเบอร์โทรศัพท์ — เวลาสมัครสมาชิก หรือให้พนักงานเปิดบัญชีให้ที่เคาน์เตอร์</li>
        <li>บัญชี Google — เฉพาะเมื่อคุณเลือกเข้าสู่ระบบด้วย Google ที่หน้าเข้าสู่ระบบลูกค้า</li>
        <li>ประวัติการซื้อขาย ยอดแต้มสะสม และยอดค้างชำระของคุณ</li>
        <li>ข้อมูลการสั่งซื้อล่วงหน้า รวมถึงรหัสรับของ 4 หลักที่ใช้รับสินค้า</li>
        <li>รายการที่คุณขายสินค้าให้ร้านแบบฝากขาย (consignment) ถ้าคุณมี</li>
        <li>
          <strong>สิ่งที่คุณกรอกในแบบฟอร์มฝากขายในหน้าบัญชีของคุณ</strong> — ชื่อสินค้า
          ราคาที่ต้องการขาย จำนวนชิ้น รายละเอียดเพิ่มเติม และลิงก์รูปหรือเอกสารที่แนบมา
          (ถ้ามี) ร้านเก็บเฉพาะลิงก์ ไม่ได้เก็บไฟล์รูปไว้ในระบบ
        </li>
      </ul>
      <p className={styles.notCollected}>
        <strong>สิ่งที่ร้านไม่ขอจากคุณ:</strong> ไม่ขอเลขประจำตัวประชาชน ไม่ขอข้อมูลสุขภาพ
        ไม่ขอรูปบัตรประชาชน และไม่ขอเลขบัญชีธนาคารของคุณ
      </p>
    </section>

    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>2. ทำไมร้านจึงเก็บ</h2>
      <ul className={styles.list}>
        <li>
          <strong>เพื่อออกใบเสร็จและใบกำกับภาษี</strong> — เป็นหน้าที่ตามสัญญาที่คุณซื้อสินค้า
          กรณีนี้จึงไม่ต้องขอความยินยอมจากคุณ
        </li>
        <li>
          <strong>เพื่อให้คุณดูประวัติการซื้อ ใบเสร็จ และยอดแต้มของตัวเองได้</strong> — ดูได้ในบัญชีของคุณเอง
        </li>
        <li>
          <strong>เพื่อยืนยันตัวตนด้วยรหัสยืนยัน (OTP)</strong> — เวลามีการเปลี่ยนแปลงข้อมูลบัญชี
          หรือเข้าสู่ระบบครั้งแรก
        </li>
        <li>
          <strong>เพื่อแจ้งเตือนเรื่องพรีออเดอร์และการรับสินค้า</strong> — เมื่อร้านตั้งช่องทางแจ้งเตือนไว้
        </li>
        <li>
          <strong>เพื่อพิจารณาคำขอฝากขายที่คุณส่งมา</strong> — ร้านจะตรวจสอบสินค้าและเอกสารที่แนบมา
          ก่อนตกลงส่วนแบ่งกับคุณ และจะแจ้งผลให้ทราบในหน้าบัญชีของคุณ
        </li>
      </ul>
    </section>

    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>3. ใครมีสิทธิ์เห็นข้อมูลของคุณ</h2>
      <p className={styles.body}>
        ร้านเป็นผู้ควบคุมข้อมูลของคุณ แต่ร้านไม่ได้ดูข้อมูลทุกส่วนด้วยตัวเอง
        พนักงานแต่ละตำแหน่งเห็นเฉพาะเท่าที่งานของตำแหน่งนั้นต้องใช้
      </p>
      <ul className={styles.list}>
        <li>
          <strong>พนักงานที่ให้บริการ</strong> — เห็นเฉพาะชื่อและเบอร์โทรที่จำเป็นต่อการขาย
          เช่นตอนค้นหาสมาชิกหรือรับสินค้า
        </li>
        <li>
          <strong>ผู้จัดการของร้าน</strong> — เห็นข้อมูลสมาชิกและประวัติการขายทั้งหมดของร้าน
        </li>
        <li>
          <strong>คุณเอง</strong> — ดูข้อมูลของคุณได้ในหน้าบัญชีของคุณ
          และเปิดใบเสร็จของตัวเองได้ตามระยะเวลาที่ร้านเปิดให้ดาวน์โหลด
        </li>
      </ul>
      <p className={styles.body}>
        ระบบบันทึกการเข้าใช้งานและการแก้ไขข้อมูลสำคัญไว้ เพื่อให้ตรวจสอบย้อนหลังได้ว่าใครเข้าถึงอะไร
      </p>
    </section>

    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>4. มีการส่งข้อมูลให้บุคคลหรือองค์กรอื่นหรือไม่</h2>
      <p className={styles.body}>มี 3 กรณีเท่านั้น และเฉพาะกรณีที่คุณใช้บริการนั้น</p>
      <ul className={styles.list}>
        <li>
          <strong>Google</strong> — เมื่อคุณเลือกเข้าสู่ระบบด้วย Google
          ระบบจะรับชื่อและอีเมลของคุณจาก Google เพื่อเปิดบัญชี
          เบอร์โทรศัพท์ยังเป็นตัวระบุตัวตนหลักของคุณ
        </li>
        <li>
          <strong>ช่องทางแจ้งเตือนของร้าน (LINE หรือ Webhook)</strong> — เมื่อมีการแจ้งเตือน
          เช่น พรีออเดอร์พร้อม หรือรหัสรับของ
        </li>
        <li>
          <strong>ธนาคาร</strong> — เมื่อคุณชำระผ่านพร้อมเพย์ ธนาคารจะเห็นข้อมูลการโอนตามที่ธนาคารต้องใช้
          ตามกฎหมายของธนาคาร
        </li>
      </ul>
    </section>

    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>5. ร้านเก็บข้อมูลลูกค้าไว้นานเท่าไหร่</h2>
      <ul className={styles.list}>
        <li>
          <strong>ใบเสร็จและใบกำกับภาษี</strong> — เก็บไว้ตามระยะเวลาที่กฎหมายภาษีกำหนดสำหรับเอกสารทางการเงิน
        </li>
        <li>
          <strong>ประวัติการซื้อขายในบัญชีสมาชิก</strong> — เก็บไว้ตราบใดที่บัญชีของคุณยังเปิดอยู่
          หากคุณปิดบัญชี ประวัติการซื้อขายจะถูกเก็บไว้เฉพาะส่วนที่กฎหมายภาษีต้องให้เก็บ
        </li>
        <li>
          <strong>รูปใบเสร็จอิเล็กทรอนิกส์</strong> — ดาวน์โหลดได้ 30 วันนับจากวันที่ขาย
          หลังจากนั้นลิงก์จะปิด แต่<strong>ข้อมูลการขายไม่ถูกลบ</strong>
          รายการซื้อขายยังอยู่ในประวัติของคุณ และร้านยังพิมพ์สำเนาให้ได้
        </li>
        <li>
          <strong>รหัสยืนยัน (OTP)</strong> — หมดอายุภายใน 5 นาที และใช้ได้ครั้งเดียว
        </li>
        <li>
          <strong>ข้อมูลบนเครื่องขายของร้าน (แท็บเล็ตที่เตรียมไว้)</strong> — เก็บแคตตาล็อกและบิลที่ยังส่งไม่ถึงเซิร์ฟเวอร์
          เพื่อให้ร้านขายต่อได้เมื่อเน็ตหลุด บิลเหล่านั้นจะถูกส่งให้อัตโนมัติเมื่อเน็ตกลับมา
        </li>
      </ul>
    </section>

    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>6. สิทธิของคุณ</h2>
      <p className={styles.body}>คุณมีสิทธิต่อไปนี้</p>
      <ul className={styles.list}>
        <li>ขอดูหรือขอสำเนาข้อมูลของคุณ</li>
        <li>ขอแก้ไขข้อมูลที่ไม่ถูกต้องหรือไม่ครบถ้วน</li>
        <li>ขอให้ลบข้อมูล หรือให้เปลี่ยนข้อมูลเป็นข้อมูลที่ระบุตัวบุคคลไม่ได้</li>
        <li>ขอจำกัดการใช้ข้อมูลของคุณ</li>
        <li>ขอคัดลอกข้อมูลของคุณออกไปในรูปแบบที่เครื่องมืออัตโนมัติอ่านได้</li>
        <li>คัดค้านการใช้ข้อมูลบางอย่างของคุณ</li>
        <li>ถอนความยินยอม หากคุณเคยให้ไว้</li>
      </ul>
      <p className={styles.body}>
        ขอได้ที่หน้าเคาน์เตอร์ของร้าน หรือติดต่อร้านตามข้อมูลด้านล่าง ร้านจะดำเนินการโดยไม่ชักช้า
        และจะแจ้งเหตุผลให้ทราบ หากไม่สามารถทำได้
      </p>
      <p className={styles.body}>
        หน้าบัญชีของคุณแสดงประวัติการซื้อและเปิดใบเสร็จได้ในตัว
        แต่การขอสำเนาข้อมูลทั้งหมดหรือขอไฟล์ข้อมูลในรูปแบบอื่น ต้องให้ร้านเป็นผู้จัดทำให้
        กรุณาติดต่อที่หน้าเคาน์เตอร์
      </p>
      <p className={styles.body}>
        <strong>ข้อยกเว้น:</strong> เอกสารทางบัญชีและภาษีต้องเก็บไว้ตามกฎหมาย
        แม้คุณจะขอให้ลบ ร้านจะลบเฉพาะส่วนที่ไม่ต้องเก็บตามกฎหมาย
        และจะแจ้งให้ทราบว่าอะไรถูกเก็บไว้และเพราะอะไร
      </p>
    </section>

    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>7. ความปลอดภัยของข้อมูล</h2>
      <ul className={styles.list}>
        <li>รหัสผ่านถูกเข้ารหัสก่อนบันทึก ไม่ได้เก็บเป็นคำผ่านเปล่า</li>
        <li>การเข้าใช้งานทุกครั้งตรวจสอบสิทธิ์ตามตำแหน่ง ผู้จัดการหรือพนักงาน</li>
        <li>จำกัดจำนวนครั้งที่ลองเข้าระบบ เพื่อกันการเดารหัสผ่าน</li>
        <li>มีบันทึกการใช้งานและการแก้ไขข้อมูลสำคัญ เพื่อให้ตรวจสอบย้อนหลังได้</li>
        <li>เข้าระบบผ่านการเชื่อมต่อที่เข้ารหัส (HTTPS)</li>
      </ul>
      <p className={styles.body}>
        หากเกิดเหตุการละเมิดข้อมูลขึ้น ร้านจะประเมินสถานการณ์ แจ้งสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล
        ภายในเวลาที่กฎหมายกำหนด และแจ้งคุณโดยเร็วหากกระทบสิทธิของคุณ
      </p>
    </section>

    <section className={styles.section}>
      <h2 className={styles.sectionHeading}>8. ติดต่อผู้ควบคุมข้อมูล และร้องเรียน</h2>
      <p className={styles.contact}>
        <strong>ผู้ควบคุมข้อมูลส่วนบุคคล</strong>
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
        หากร้านไม่ปฏิบัติตามนโยบายนี้ คุณสามารถร้องเรียนต่อสำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล (สคส.)
        ได้ที่ <strong>pdpc.or.th</strong> — หรือร้องเรียนต่อร้านโดยตรงตามข้อมูลข้างต้นก่อน
      </p>
    </section>
  </article>
  );
}
