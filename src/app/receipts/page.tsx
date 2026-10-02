import type { Metadata } from 'next';

import { PublicReceipt } from '@/components/receipts/PublicReceipt';
import { Card, EmptyState } from '@/components/ds';
import { DomainError } from '@/lib/errors';
import { loadReceiptByLink } from '@/lib/order-view';

import styles from './receipt-page.module.css';

export const metadata: Metadata = { title: 'ใบเสร็จอิเล็กทรอนิกส์' };

/**
 * The page a customer's receipt link opens (ADR 0021 §2, §3).
 *
 * The counter hands a walk-in a link, and this is what they see when they open it or
 * scan its QR — the receipt itself, printable and downloadable, with no account and
 * no session. The token rides in the query (`?t=`) rather than the path, so one static
 * route serves every link and the route audit can walk it; the token is the credential
 * either way, and it names exactly one order.
 *
 * Every failure — a missing token, a tampered one, an expired one, a sale past the
 * one-month window — renders the same styled refusal. Which of those it was is not the
 * customer's to learn, and a page that said "expired" versus "forged" would only help
 * somebody probing links.
 */
export default async function PublicReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;

  if (!t) {
    return <Refusal description="ลิงก์ใบเสร็จไม่ครบถ้วน — กรุณาติดต่อร้านเพื่อขอลิงก์ใหม่" />;
  }

  try {
    const { shop, receipt } = await loadReceiptByLink(t);
    return <PublicReceipt shop={shop} data={receipt} />;
  } catch (error) {
    /*
     * A domain refusal (bad token, expired link, closed window) and any other failure
     * are the same thing to the person holding the phone: no receipt here. The reason
     * is not shown, and the link may simply have aged out of the month.
     */
    if (error instanceof DomainError) {
      return (
        <Refusal description="ลิงก์นี้ใช้ไม่ได้แล้ว — อาจหมดอายุ หรือใบเสร็จเกิน 1 เดือนแล้ว" />
      );
    }
    return <Refusal description="เปิดใบเสร็จไม่สำเร็จ — กรุณาลองใหม่หรือติดต่อร้าน" />;
  }
}

function Refusal({ description }: { description: string }) {
  return (
    <main className={styles.page}>
      <Card>
        <EmptyState icon="receipt" title="ไม่พบใบเสร็จ" description={description} />
      </Card>
    </main>
  );
}
