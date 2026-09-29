/**
 * Reading the catalogue.
 *
 * This exists because of a defect that only shows up in a real shop. The products
 * route used to answer with `findMany({ take: 200 })` and nothing else, and the
 * till fetched that once and filtered it in the browser. A shop with two hundred
 * and one products therefore could not sell the two hundred and first: the item
 * existed, could be imported, could be stocked, and simply was not in the array the
 * till had.
 *
 * The reference design's own field notes name the same shape of problem from the
 * other end — a till that gets slow as a day's history piles up. Both answers are
 * the same answer: never send a whole table to a browser. So the query is paging
 * and filtering on the server, and the browser asks for what it is about to draw.
 *
 * Pure and dependency-injected so it can be unit-tested against a real database
 * without going through HTTP, which is how the rest of this codebase tests.
 */
import { prisma } from './db';
import { fromDecimal } from './money';
import { toProductView, type ProductView, type ProductRow } from './product-view';

/**
 * The shape the browser gets: Decimals become numbers, availability is derived.
 *
 * Structurally the client-safe view plus the fields only the back office has any use
 * for — the cost price and the description — so a till that receives this DTO and a
 * till that receives a `ProductView` can share every component that draws a product
 * tile. The image link is in neither of those two groups any more: the tiles draw it,
 * so it lives in `ProductView` itself (ADR 0014).
 */
export interface ProductDto extends ProductView {
  description: string | null;
  costPrice: number;
}

/**
 * One page of products, and how many there are in total.
 *
 * `total` is returned rather than being inferable from the page, because the till
 * has to tell an operator "ยังมีอีก 140 รายการ" — a page that ends without that
 * sentence reads as "no more products", and the next request is a support call.
 */
export interface ProductPage {
  items: ProductDto[];
  total: number;
}

export const PRODUCT_PAGE_SIZE = 60;
export const PRODUCT_PAGE_SIZE_MAX = 200;

export interface ProductQuery {
  search?: string | null;
  barcode?: string | null;
  categoryId?: number | null;
  includeInactive?: boolean;
  limit?: number | null;
  offset?: number | null;
}

function normalizeLimit(limit: number | null | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) {
    return PRODUCT_PAGE_SIZE;
  }
  return Math.min(Math.trunc(limit), PRODUCT_PAGE_SIZE_MAX);
}

function normalizeOffset(offset: number | null | undefined): number {
  if (!offset || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.trunc(offset);
}

export async function listProducts(query: ProductQuery = {}): Promise<ProductPage> {
  const search = query.search?.trim();
  const barcode = query.barcode?.trim();

  const where = {
    ...(query.includeInactive ? {} : { is_active: true }),
    ...(barcode ? { barcode } : {}),
    ...(query.categoryId ? { category_id: query.categoryId } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { barcode: { contains: search } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.products.findMany({
      where,
      include: { category: { select: { name: true } } },
      // Name, then id: two products called "น้ำเปล่า" must have a stable order, or
      // paging can show the same row twice and skip another.
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: normalizeLimit(query.limit),
      skip: normalizeOffset(query.offset),
    }),
    prisma.products.count({ where }),
  ]);

  return { items: rows.map(toProductDto), total };
}

export function toProductDto(
  product: ProductRow & {
    description: string | null;
    cost_price: unknown;
  },
): ProductDto {
  return {
    ...toProductView(product),
    description: product.description,
    costPrice: fromDecimal(product.cost_price as never),
  };
}
