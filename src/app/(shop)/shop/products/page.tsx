import { PageHeader, Pill, Stack } from '@/components/ds';
import type { ShopProduct } from '@/components/shop/ShopCatalog';
import { ShopCatalog } from '@/components/shop/ShopCatalog';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { availableQty } from '@/lib/inventory';
import { fromDecimal } from '@/lib/money';

/**
 * The member storefront — SRS §3 Phase 1.
 *
 * `category_id` is loaded alongside the name so the aisle headings can wear the
 * category's own colour (`CategoryChip`), which is what makes a shop with twenty
 * aisles browsable rather than one long list of product names. `image_url` rides
 * along for the tile's photo — a link the shop pasted, not a file this deployment
 * stores (ADR 0014).
 */
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
    categoryId: product.category_id,
    categoryName: product.category?.name ?? null,
    imageUrl: product.image_url,
  }));

  return (
    <Stack gap="lg">
      <PageHeader
        title="สินค้าทั้งหมด"
        subtitle="จำนวนที่แสดงคือจำนวนที่ขายได้จริง หลังหักสินค้าที่ถูกจองไว้แล้ว"
        actions={
          <Pill tone="warning" icon="star">
            {(user?.points_balance ?? 0).toLocaleString('en-US')} คะแนน
          </Pill>
        }
      />
      <ShopCatalog initialProducts={initialProducts} />
    </Stack>
  );
}
