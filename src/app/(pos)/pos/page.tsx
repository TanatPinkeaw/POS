import type { PosProduct } from '@/components/pos/PosTerminal';
import { PosScreen } from '@/components/pos/PosScreen';
import { prisma } from '@/lib/db';
import { availableQty } from '@/lib/inventory';
import { fromDecimal } from '@/lib/money';

/**
 * Products are loaded on the server and handed to the client as initial state,
 * so the till paints with a sellable catalogue instead of an empty grid, and
 * realtime stock events take over from there.
 */
export default async function PosPage() {
  const products = await prisma.products.findMany({
    where: { is_active: true },
    include: { category: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });

  const initialProducts: PosProduct[] = products.map((product) => ({
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

  return <PosScreen initialProducts={initialProducts} />;
}
