'use client';

import { PosTerminal, type PosProduct } from './PosTerminal';
import { ShiftPanel } from './ShiftPanel';
import { useOpenShift } from './useOpenShift';

/**
 * The till.
 *
 * The drawer and the cart share one `useOpenShift` instance here rather than
 * each fetching it, so closing a shift cannot leave the cart still believing a
 * drawer is open.
 */
export function PosScreen({ initialProducts }: { initialProducts: PosProduct[] }) {
  const { shift, defaultInitialCash, loading, refresh, open, close } = useOpenShift();

  return (
    <div className="d-flex flex-column gap-3">
      <div className="d-flex justify-content-between align-items-center">
        <div>
          <h4 className="mb-1">ขายหน้าร้าน</h4>
          <p className="text-muted mb-0 small">
            สแกนบาร์โค้ดหรือเลือกสินค้า สต็อกจะอัปเดตทุกหน้าจอทันที
          </p>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-12 col-xl-4">
          <ShiftPanel
            shift={shift}
            defaultInitialCash={defaultInitialCash}
            loading={loading}
            onOpen={open}
            onClose={close}
          />
        </div>
        <div className="col-12 col-xl-8">
          <PosTerminal initialProducts={initialProducts} shift={shift} onShiftRefresh={refresh} />
        </div>
      </div>
    </div>
  );
}
