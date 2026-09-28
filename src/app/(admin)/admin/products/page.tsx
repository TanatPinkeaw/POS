import { AdminProducts, type AdminProduct } from '@/components/admin/AdminProducts';
import { CategoryManager } from '@/components/admin/CategoryManager';
import { ProductImportPanel } from '@/components/admin/ProductImportPanel';
import { prisma } from '@/lib/db';
import { availableQty } from '@/lib/inventory';
import { fromDecimal } from '@/lib/money';

/**
 * The catalogue screen.
 *
 * Three concerns, in the order a renter meets them: load the catalogue (import),
 * organise it (categories), then live with it (the product and stock table). The
 * import and category panels are additions on top of the SRS's product screen —
 * without them the only way to fill a catalogue was the seed file.
 */
export const dynamic = 'force-dynamic';

export default async function AdminProductsPage() {
  const [products, categories] = await Promise.all([
    prisma.products.findMany({
      include: { category: { select: { name: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.categories.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    }),
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

  return (
    <>
      <AdminProducts initialProducts={initialProducts} categories={categories} />

      <div className="mt-4">
        <ProductImportPanel />
      </div>

      <div className="mt-4">
        <CategoryManager
          initialCategories={categories.map((category) => ({
            id: category.id,
            name: category.name,
            productCount: category._count.products,
          }))}
        />
      </div>
    </>
  );
}
