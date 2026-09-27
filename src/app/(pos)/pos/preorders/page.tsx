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
    <div className="d-flex flex-column gap-3">
      {swept.expired > 0 && (
        <div className="alert alert-warning py-2 small mb-0">
          คืนสต็อกจากออเดอร์ที่หมดอายุแล้ว {swept.expired} รายการ
        </div>
      )}
      <PreOrderBoard />
    </div>
  );
}
