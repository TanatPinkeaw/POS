import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ValidationError } from '@/lib/errors';
import { availableQty } from '@/lib/inventory';
import { fromDecimal } from '@/lib/money';
import { productCreateSchema } from '@/lib/schemas';

/** Shape sent to the browser: Decimals become numbers, availability is derived. */
export interface ProductDto {
  id: string;
  name: string;
  barcode: string | null;
  description: string | null;
  categoryId: number | null;
  categoryName: string | null;
  costPrice: number;
  salePrice: number;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  imageUrl: string | null;
  isActive: boolean;
}

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['member', 'employee', 'admin']);

    const params = new URL(request.url).searchParams;
    const search = params.get('search')?.trim();
    const barcode = params.get('barcode')?.trim();
    const categoryId = params.get('categoryId');
    const includeInactive = params.get('includeInactive') === 'true';

    const products = await prisma.products.findMany({
      where: {
        ...(includeInactive ? {} : { is_active: true }),
        ...(barcode ? { barcode } : {}),
        ...(categoryId ? { category_id: Number(categoryId) } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { barcode: { contains: search } },
              ],
            }
          : {}),
      },
      include: { category: { select: { name: true } } },
      orderBy: { name: 'asc' },
      take: 200,
    });

    return products.map<ProductDto>((product) => ({
      id: product.id,
      name: product.name,
      barcode: product.barcode,
      description: product.description,
      categoryId: product.category_id,
      categoryName: product.category?.name ?? null,
      costPrice: fromDecimal(product.cost_price),
      salePrice: fromDecimal(product.sale_price),
      stockQty: product.stock_qty,
      reservedQty: product.reserved_qty,
      availableQty: availableQty({ stock_qty: product.stock_qty, reserved_qty: product.reserved_qty }),
      imageUrl: product.image_url,
      isActive: product.is_active,
    }));
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
