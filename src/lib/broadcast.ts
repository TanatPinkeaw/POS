/**
 * Application-level broadcast helpers.
 *
 * These sit between the routes and the transport: they read whatever state the
 * event needs and hand it to `notify`. Keeping them out of `notify.ts` means
 * that module stays transport-only and free of database access.
 */
import { prisma } from './db';
import { availableQty } from './inventory';
import { notifyPointsChanged, notifyStockChanged } from './notify';

/** Pushes fresh stock counters for the given products to every open screen. */
export async function broadcastStockFor(productIds: string[]): Promise<void> {
  const unique = [...new Set(productIds)];
  if (unique.length === 0) {
    return;
  }

  const products = await prisma.products.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, stock_qty: true, reserved_qty: true },
  });

  for (const product of products) {
    notifyStockChanged({
      productId: product.id,
      name: product.name,
      stockQty: product.stock_qty,
      reservedQty: product.reserved_qty,
      availableQty: availableQty({
        stock_qty: product.stock_qty,
        reserved_qty: product.reserved_qty,
      }),
    });
  }
}

/** Pushes a customer's current point balance to their own screens. */
export async function broadcastPointsFor(userId: string | null | undefined): Promise<void> {
  if (!userId) {
    return;
  }

  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: { points_balance: true },
  });
  if (user) {
    notifyPointsChanged(userId, user.points_balance);
  }
}
