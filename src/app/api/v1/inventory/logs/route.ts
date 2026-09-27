import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';

/**
 * SRS §4.3 audit trail — the read side of `stock_logs`.
 *
 * Admins and floor staff can both read it, because a clerk investigating a
 * count needs the history as much as the manager signing it off.
 */
export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);

    const params = new URL(request.url).searchParams;
    const productId = params.get('productId');
    const limit = Math.min(Number(params.get('limit') ?? 100) || 100, 500);

    const logs = await prisma.stock_logs.findMany({
      where: productId ? { product_id: productId } : {},
      include: {
        product: { select: { name: true, barcode: true } },
        user: { select: { full_name: true, role: true } },
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });

    return logs.map((log) => ({
      id: log.id.toString(),
      createdAt: log.created_at,
      productId: log.product_id,
      productName: log.product.name,
      barcode: log.product.barcode,
      movementType: log.movement_type,
      reason: log.reason,
      qtyChanged: log.qty_changed,
      balanceAfter: log.balance_after,
      adjustedBy: log.user.full_name,
      adjustedByRole: log.user.role,
      note: log.note,
    }));
  });
}
