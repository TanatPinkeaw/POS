import { NextResponse } from 'next/server';

import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ValidationError } from '@/lib/errors';
import { listProducts, PRODUCT_PAGE_SIZE, type ProductDto } from '@/lib/product-query';
import { productCreateSchema } from '@/lib/schemas';

export type { ProductDto };

/**
 * The catalogue.
 *
 * Paged and filtered on the server (`listProducts`), because the previous
 * `take: 200` made every product after the two hundredth unsellable — see the note
 * in `src/lib/product-query.ts`.
 *
 * The response stays a bare array rather than becoming an envelope, so the existing
 * callers keep working; the count a caller needs for "ยังมีอีก N รายการ" comes back
 * in `X-Total-Count`, which is what a client that did not ask for paging will never
 * look at and a client that did can rely on.
 */
export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['member', 'employee', 'admin']);

    const params = new URL(request.url).searchParams;
    const categoryId = params.get('categoryId');
    const limit = Number(params.get('limit') ?? PRODUCT_PAGE_SIZE);
    const offset = Number(params.get('offset') ?? 0);

    const page = await listProducts({
      search: params.get('search'),
      barcode: params.get('barcode'),
      categoryId: categoryId ? Number(categoryId) : null,
      includeInactive: params.get('includeInactive') === 'true',
      limit,
      offset,
    });

    /*
     * The envelope is load-bearing, and forgetting it is a genuinely easy mistake:
     * every consumer in this codebase unwraps `{ data }` (that is what `apiFetch`
     * does, and what the smoke and acceptance harnesses do). Returning the array
     * bare *looks* tidier and breaks all of them — worse, it breaks them 250ms
     * later, when a debounced refetch assigns `undefined` into a component's state
     * and the screen throws somewhere that looks unrelated to this line.
     */
    return NextResponse.json(
      { data: page.items },
      {
        headers: {
          /* How many the filter matched, not how many were sent. */
          'X-Total-Count': String(page.total),
          'X-Page-Size': String(PRODUCT_PAGE_SIZE),
        },
      },
    );
  });
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const body = await readJson(request, productCreateSchema);

    if (body.barcode) {
      const clash = await prisma.products.findUnique({ where: { barcode: body.barcode } });
      if (clash) {
        throw new ValidationError(`Barcode ${body.barcode} is already used by "${clash.name}"`);
      }
    }

    const created = await prisma.products.create({
      data: {
        name: body.name,
        category_id: body.categoryId ?? null,
        barcode: body.barcode ?? null,
        description: body.description ?? null,
        cost_price: body.costPrice,
        sale_price: body.salePrice,
        stock_qty: body.stockQty,
        image_url: body.imageUrl ?? null,
        is_active: body.isActive,
      },
    });

    return { id: created.id, name: created.name };
  });
}
