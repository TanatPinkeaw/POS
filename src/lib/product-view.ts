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
 *
 * `offlineSafetyQty` is here for a different reason: the device's catalogue snapshot
 * *is* the thing that decides whether it may sell this product with no network, and
 * the snapshot is filled from this view. A reserve the back office sets but the till
 * never receives would be a setting that does nothing (ADR 0019).
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
  /**
   * How much of this product the till may not sell while it is offline (ADR 0019).
   * Zero means no reserve. It is a device rule; nothing on the online sale path reads it.
   */
  offlineSafetyQty: number;
  /**
   * Whether the goods belong to a consignor rather than the shop (ADR 0023).
   *
   * The till needs this only for the offline path: a consigned sale owes a share the device
   * cannot compute or record, so the offline rule refuses it (ADR 0023 §8). Online sale and
   * pre-order read it nowhere — presence here is not a restriction on selling, which is why
   * it is a boolean and not the consignor's identity.
   */
  isConsigned: boolean;
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
  offline_safety_qty: number;
  image_url: string | null;
  is_active: boolean;
  consignor_user_id: string | null;
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
    offlineSafetyQty: product.offline_safety_qty,
    isConsigned: product.consignor_user_id !== null,
    imageUrl: product.image_url,
    isActive: product.is_active,
  };
}
