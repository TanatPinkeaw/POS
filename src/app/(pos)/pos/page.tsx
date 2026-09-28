import { PosScreen } from '@/components/pos/PosScreen';
import type { CatalogueCategory } from '@/components/pos/TillCatalog';
import { prisma } from '@/lib/db';
import { listProducts, PRODUCT_PAGE_SIZE } from '@/lib/product-query';
import { categoryColorKey } from '@/lib/palette';
import { loadShop } from '@/lib/shop';
import { UNCONFIGURED_SHOP } from '@/lib/shop-view';

/**
 * The till's first paint.
 *
 * It used to load *every* active product server-side and hand the whole catalogue
 * to the browser, which is the same defect the products route had, one layer up: a
 * shop with a few thousand SKUs would ship all of them in the page payload on every
 * navigation. Now it ships one page, and the counts the category rail needs — a
 * number per aisle, not the products themselves.
 *
 * `force-dynamic` because a till is never a cached document: its stock counts are
 * only correct for the second they were read.
 */
export const dynamic = 'force-dynamic';

export default async function PosPage() {
  const [page, categories, shop] = await Promise.all([
    listProducts({ limit: PRODUCT_PAGE_SIZE }),
    prisma.categories.findMany({
      select: { id: true, name: true, _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
    }),
    loadShop(),
  ]);

  const catalogue: CatalogueCategory[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    productCount: category._count.products,
  }));

  // The aisle colour is derived here as well as in the browser, so a server-rendered
  // tile and a client-rendered one cannot disagree about which colour an aisle is.
  const initialProducts = page.items.map((item) => ({
    ...item,
    categoryKey: categoryColorKey(item.categoryId),
  }));

  return (
    <PosScreen
      initialProducts={initialProducts}
      initialTotal={page.total}
      categories={catalogue}
      shop={shop ?? UNCONFIGURED_SHOP}
    />
  );
}
