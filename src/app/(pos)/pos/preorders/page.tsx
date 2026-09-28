import { InlineNotice, PageHeader, Stack } from '@/components/ds';
import { PreOrderBoard } from '@/components/pos/PreOrderBoard';
import { expireStalePendingOrders } from '@/lib/orders';

/**
 * The board also sweeps on read.
 *
 * The interval sweeper runs in the background, but doing a sweep here too means
 * expiry is correct even if the process was restarting at the moment a deadline
 * passed — the person looking at the board is exactly the person who needs the
 * numbers to be right.
 */
export default async function PreOrdersPage() {
  const swept = await expireStalePendingOrders();

  return (
    <Stack gap="lg">
      <PageHeader
        title="กระดานพรีออเดอร์"
        subtitle="ออเดอร์ที่ไม่ได้ยืนยันภายใน 15 นาที จะถูกยกเลิกและคืนสต็อกอัตโนมัติ"
      />
      {swept.expired > 0 ? (
        <InlineNotice tone="warning">
          คืนสต็อกจากออเดอร์ที่หมดอายุแล้ว {swept.expired} รายการ
        </InlineNotice>
      ) : null}
      <PreOrderBoard />
    </Stack>
  );
}
