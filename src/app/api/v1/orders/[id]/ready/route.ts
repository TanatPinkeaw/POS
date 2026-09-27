import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { loadOrderView } from '@/lib/order-view';
import { markOrderReady } from '@/lib/orders';
import { notifyOrderUpdated } from '@/lib/notify';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * SRS §3 Phase 3 — the order is packed and tagged.
 *
 * The customer is handed a 4-digit PIN and a hold deadline; the staff board
 * shows both, so a no-show is a visible decision rather than a silent one.
 */
export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const { id } = await context.params;

    const { pickupPin, pickupExpiresAt } = await markOrderReady({
      orderId: id,
      employeeId: session.id,
    });

    const order = await loadOrderView(id);
    notifyOrderUpdated({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      orderType: order.orderType,
      customerId: order.customer?.id ?? null,
      finalAmountThb: order.finalAmountThb,
      pickupPin,
    });

    return { ...order, pickupPin, pickupExpiresAt };
  });
}
