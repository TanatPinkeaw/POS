import { AdminProducts, type AdminProduct } from '@/components/admin/AdminProducts';
import { prisma } from '@/lib/db';
import { availableQty } from '@/lib/inventory';
import { fromDecimal } from '@/lib/money';

export default async function AdminProductsPage() {
  const [products, categories] = await Promise.all([
    prisma.products.findMany({
      include: { category: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.categories.findMany({ orderBy: { name: 'asc' } }),
  ]);

  const initialProducts: AdminProduct[] = products.map((product) => ({
    id: product.id,
    name: product.name,
    barcode: product.barcode,
    categoryId: product.category_id,
    categoryName: product.category?.name ?? null,
    costPrice: fromDecimal(product.cost_price),
    salePrice: fromDecimal(product.sale_price),
    stockQty: product.stock_qty,
    reservedQty: product.reserved_qty,
    availableQty: availableQty({
      stock_qty: product.stock_qty,
      reserved_qty: product.reserved_qty,
    }),
    isActive: product.is_active,
  }));

  return <AdminProducts initialProducts={initialProducts} categories={categories} />;
}
