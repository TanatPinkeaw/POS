import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { NotFoundError } from '@/lib/errors';
import { findOrderForHandover } from '@/lib/orders';
import { handoverLookupSchema } from '@/lib/schemas';

/**
 * SRS §3 Phase 4: the customer arrives and presents a QR code, a PIN, or their
 * registered phone number.
 *
 * Staff-only, because it deliberately returns an order belonging to somebody
 * else — the whole point of a handover counter.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);
    const body = await readJson(request, handoverLookupSchema);

    const order = await findOrderForHandover(body);
    if (!order) {
      throw new NotFoundError(
        'No order is waiting for collection with those details',
      );
    }

    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.status,
      pickupPin: order.pickup_pin,
      finalAmountThb: Number(order.final_amount),
      pickupExpiresAt: order.pickup_expires_at,
      customer: order.customer
        ? {
            id: order.customer.id,
            fullName: order.customer.full_name,
            phone: order.customer.phone,
            pointsBalance: order.customer.points_balance,
          }
        : null,
      items: order.items.map((item) => ({
        productId: item.product_id,
        name: item.product.name,
        quantity: item.quantity,
        unitPrice: Number(item.unit_price),
        totalPrice: Number(item.total_price),
      })),
    };
  });
}
