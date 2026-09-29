/**
 * What a browser is allowed to know about a product.
 *
 * Separate from `product-query.ts`, which imports the database client: a type
 * imported into a client component must not drag `prisma` into the browser bundle,
 * and in practice the boundary is worth stating anyway — a screen sees a sale price
 * and an availability count, never a cost price by accident, and never a Decimal.
 *
 * `categoryKey` is derived, not stored: it is the aisle colour (see
 * `categoryColorKey`), sent alongside the data so the grid can colour a tile
 * without shipping the whole palette table to the client.
 *
 * `imageUrl` is here rather than in `ProductDto` because the tiles draw it: the till
 * and the storefront show the same photo the back office entered, and a field a tile
 * renders cannot be a back-office secret (ADR 0014). What the photo *is* — a link to
 * another host — is decided in `image-url.ts`, not here.
 */
import { availableQty } from './inventory';
import { fromDecimal } from './money';
import { categoryColorKey } from './palette';

export interface ProductView {
  id: string;
  name: string;
  barcode: string | null;
  categoryId: number | null;
  categoryName: string | null;
  /** The aisle colour key, derived from the category id. */
  categoryKey: string;
  salePrice: number;
  stockQty: number;
  reservedQty: number;
  /** What can actually be sold: stock minus what pre-orders have reserved. */
  availableQty: number;
  /** A link to the picture, wherever the shop keeps it. Not necessarily renderable. */
  imageUrl: string | null;
  isActive: boolean;
}

/** The database row shape this mapper accepts, stated structurally. */
export interface ProductRow {
  id: string;
  name: string;
  barcode: string | null;
  category_id: number | null;
  category?: { name: string } | null;
  sale_price: unknown;
  stock_qty: number;
  reserved_qty: number;
  image_url: string | null;
  is_active: boolean;
}

export function toProductView(product: ProductRow): ProductView {
  return {
    id: product.id,
    name: product.name,
    barcode: product.barcode,
    categoryId: product.category_id,
    categoryName: product.category?.name ?? null,
    categoryKey: categoryColorKey(product.category_id),
    salePrice: fromDecimal(product.sale_price as never),
    stockQty: product.stock_qty,
    reservedQty: product.reserved_qty,
    availableQty: availableQty({
      stock_qty: product.stock_qty,
      reserved_qty: product.reserved_qty,
    }),
    imageUrl: product.image_url,
    isActive: product.is_active,
  };
}
