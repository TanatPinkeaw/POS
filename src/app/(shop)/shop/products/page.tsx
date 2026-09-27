import type { ShopProduct } from '@/components/shop/ShopCatalog';
import { ShopCatalog } from '@/components/shop/ShopCatalog';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { availableQty } from '@/lib/inventory';
import { fromDecimal } from '@/lib/money';

export default async function ShopProductsPage() {
  const session = await getSessionUser();

  const [products, user] = await Promise.all([
    prisma.products.findMany({
      where: { is_active: true },
      include: { category: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
    session
      ? prisma.users.findUnique({
          where: { id: session.id },
          select: { id: true, points_balance: true },
        })
      : Promise.resolve(null),
  ]);

  const initialProducts: ShopProduct[] = products.map((product) => ({
    id: product.id,
    name: product.name,
    barcode: product.barcode,
    salePrice: fromDecimal(product.sale_price),
    stockQty: product.stock_qty,
    reservedQty: product.reserved_qty,
    availableQty: availableQty({
      stock_qty: product.stock_qty,
      reserved_qty: product.reserved_qty,
    }),
    categoryName: product.category?.name ?? null,
  }));

  return (
    <ShopCatalog initialProducts={initialProducts} pointsBalance={user?.points_balance ?? 0} />
  );
}
