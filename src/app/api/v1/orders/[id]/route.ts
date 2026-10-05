import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { ForbiddenError } from '@/lib/errors';
import { loadOrderView } from '@/lib/order-view';

type RouteContext = { params: Promise<{ id: string }> };

/** Full order detail, including the lines and payment legs. */
export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member', 'employee', 'admin']);
    const { id } = await context.params;

    const order = await loadOrderView(id);

    // A member may only read their own order; staff may read any.
    if (session.role === 'member' && order.customer?.id !== session.id) {
      throw new ForbiddenError('ดูได้เฉพาะออเดอร์ของคุณเท่านั้น');
    }

    return order;
  });
}
