import { redirect } from 'next/navigation';

import { ShopSettingsForm } from '@/components/admin/ShopSettingsForm';
import { bangkokParts } from '@/lib/bangkok-time';
import { loadShop } from '@/lib/shop';

/**
 * Shop settings (ADR 0002).
 *
 * A deployment without a shop is one nobody has set up, so this sends the
 * administrator to the wizard rather than rendering an empty form that would
 * fail on save.
 */
export const dynamic = 'force-dynamic';

export default async function AdminSettingsPage() {
  const shop = await loadShop();
  if (!shop) {
    redirect('/setup');
  }

  return (
    <>
      <h1 className="h4 mb-1">ตั้งค่าร้าน</h1>
      <p className="text-muted small mb-4">
        ชื่อร้าน ที่อยู่ เลขผู้เสียภาษี และเลขใบเสร็จ — ข้อมูลเหล่านี้พิมพ์อยู่บนใบเสร็จทุกใบ
      </p>

      <ShopSettingsForm initialShop={shop} previewYear={bangkokParts(new Date()).year} />
    </>
  );
}
