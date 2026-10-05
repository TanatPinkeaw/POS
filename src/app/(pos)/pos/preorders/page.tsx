import { InlineNotice, PageHeader, Stack } from '@/components/ds';
import { PreOrderBoard } from '@/components/pos/PreOrderBoard';
import { confirmTimeoutMinutes, expireStalePendingOrders } from '@/lib/orders';

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

  /*
   * The subtitle states the shop's actual timeout rather than a number typed beside
   * it. It said "15 นาที" long after the setting was thirty, which is a customer-facing
   * promise the shop was not keeping — and it is the third copy of this figure, after
   * the board's own constant and the catalogue's confirmation line. The server owns
   * the number; this is where it is read.
   */
  const confirmMinutes = confirmTimeoutMinutes();

  return (
    <Stack gap="lg">
      <PageHeader
        title="กระดานพรีออเดอร์"
        subtitle={`ออเดอร์ที่ไม่ได้ยืนยันภายใน ${confirmMinutes} นาที จะถูกยกเลิกและคืนสต็อกอัตโนมัติ`}
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
