'use client';

import type { ProductView } from '@/lib/product-view';
import type { ShopView } from '@/lib/shop-view';

import { Till } from './Till';
import type { CatalogueCategory } from './TillCatalog';

/**
 * The till's entry point.
 *
 * It used to hold the drawer's `useOpenShift` instance so the cart could not
 * believe a drawer was open after it had been closed. That responsibility now sits
 * inside `Till`, which is the only consumer — one level up was one level too many
 * for a hook whose whole purpose is to be read by the screen that spends it.
 *
 * The catalogue arrives as the *first page* rather than the whole table (see
 * `src/app/(pos)/pos/page.tsx`), so a shop with thousands of products sends the same
 * payload as a shop with thirty.
 */
export function PosScreen({
  initialProducts,
  initialTotal,
  categories,
  shop,
}: {
  initialProducts: ProductView[];
  initialTotal: number;
  categories: CatalogueCategory[];
  /** Handed to the receipt so it prints the shop's own identity. */
  shop: ShopView;
}) {
  return (
    <Till
      initialProducts={initialProducts}
      initialTotal={initialTotal}
      categories={categories}
      shop={shop}
    />
  );
}
