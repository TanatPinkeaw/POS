import { redirect } from 'next/navigation';

import { DisplayDevicesPanel } from '@/components/admin/DisplayDevicesPanel';
import { ShopSettingsForm } from '@/components/admin/ShopSettingsForm';
import { PageHeader, Stack } from '@/components/ds';
import { bangkokParts } from '@/lib/bangkok-time';
import { listDisplayDevices } from '@/lib/display-devices';
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

  // Loaded with the settings so "which screens are on my till" is answered in the
  // same paint rather than by a spinner.
  const devices = await listDisplayDevices();

  return (
    <Stack gap="lg">
      <PageHeader
        title="ตั้งค่าร้าน"
        subtitle="ชื่อร้าน ที่อยู่ เลขผู้เสียภาษี และเลขใบเสร็จ — ข้อมูลเหล่านี้พิมพ์อยู่บนใบเสร็จทุกใบ"
      />

      <ShopSettingsForm initialShop={shop} previewYear={bangkokParts(new Date()).year} />
      <DisplayDevicesPanel initialDevices={devices} />
    </Stack>
  );
}
