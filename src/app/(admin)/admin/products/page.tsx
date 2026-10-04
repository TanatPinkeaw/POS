import { AdminProducts, type AdminProduct } from '@/components/admin/AdminProducts';
import { CategoryManager } from '@/components/admin/CategoryManager';
import { ProductImportPanel } from '@/components/admin/ProductImportPanel';
import { PageHeader, Stack } from '@/components/ds';
import { prisma } from '@/lib/db';
import { availableQty } from '@/lib/inventory';
import { fromDecimal } from '@/lib/money';
import { requireShellUser } from '@/lib/shell';

/**
 * The catalogue screen.
 *
 * Three concerns, in the order a renter meets them: add stock (a product, or a
 * whole file), organise it (categories), then live with it (the product and stock
 * table). The import and category panels are additions on top of the SRS's product
 * screen — without them the only way to fill a catalogue was the seed file.
 *
 * The heading lives here rather than inside `AdminProducts`, so the page owns its
 * `<h1>`: a component that renders a page title cannot be used anywhere else, and
 * this one is the toolbar and the table.
 */
export const dynamic = 'force-dynamic';

export default async function AdminProductsPage() {
  // Admin-only under the page matrix (ADR 0022): the layout admits an employee for
  // the dashboard and reports, so each closed page states its own refusal.
  await requireShellUser(['admin']);

  const [products, categories] = await Promise.all([
    prisma.products.findMany({
      include: {
        category: { select: { name: true } },
        // Who the goods belong to, for the table's own column (ADR 0023). Null for the
        // ordinary product, which is the shop's own stock.
        consignor: { select: { full_name: true } },
      },
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
    description: product.description,
    costPrice: fromDecimal(product.cost_price),
    salePrice: fromDecimal(product.sale_price),
    stockQty: product.stock_qty,
    reservedQty: product.reserved_qty,
    availableQty: availableQty({
      stock_qty: product.stock_qty,
      reserved_qty: product.reserved_qty,
    }),
    offlineSafetyQty: product.offline_safety_qty,
    imageUrl: product.image_url,
    isActive: product.is_active,
    consignorUserId: product.consignor_user_id,
    consignorName: product.consignor?.full_name ?? null,
    consignorSharePercent: product.consignor_share_percent,
  }));

  return (
    <Stack gap="lg">
      <PageHeader
        title="สินค้าและสต็อก"
        subtitle={`${initialProducts.length} รายการ · ${categories.length} หมวด · ยอดคงเหลือเป็นแบบเรียลไทม์`}
      />

      <AdminProducts initialProducts={initialProducts} categories={categories} />

      <ProductImportPanel />

      <CategoryManager
        initialCategories={categories.map((category) => ({
          id: category.id,
          name: category.name,
          productCount: category._count.products,
        }))}
      />
    </Stack>
  );
}
