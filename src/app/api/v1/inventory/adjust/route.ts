import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { adjustStock, availableQty } from '@/lib/inventory';
import { notifyStockChanged } from '@/lib/notify';
import { stockAdjustmentSchema } from '@/lib/schemas';

/**
 * SRS §4.3: every manual stock change needs a reason and leaves an audit row.
 *
 * The reason is not merely recorded — it decides the movement type, so a
 * delivery shows up as `restock` in the audit log while a breakage shows up as
 * `manual_adjust`. Both carry the `REASON_*` enum alongside.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, stockAdjustmentSchema);

    const { balance, logId } = await prisma.$transaction((tx) =>
      adjustStock(tx, {
        productId: body.productId,
        delta: body.delta,
        reason: body.reason,
        note: body.note ?? null,
        userId: session.id,
      }),
    );

    const product = await prisma.products.findUnique({
      where: { id: body.productId },
      select: { name: true },
    });
    if (!product) {
      throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${body.productId}`);
    }

    notifyStockChanged({
      productId: body.productId,
      name: product.name,
      stockQty: balance.stock_qty,
      reservedQty: balance.reserved_qty,
      availableQty: availableQty(balance),
    });

    return {
      productId: body.productId,
      logId: logId.toString(),
      reason: body.reason,
      qtyChanged: body.delta,
      stockQty: balance.stock_qty,
      reservedQty: balance.reserved_qty,
      availableQty: availableQty(balance),
    };
  });
}
