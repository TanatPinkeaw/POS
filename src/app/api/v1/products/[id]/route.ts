import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { availableQty } from '@/lib/inventory';
import { fromDecimal } from '@/lib/money';
import { notifyStockChanged } from '@/lib/notify';
import { writeProductWithBarcode } from '@/lib/product-writes';
import { productUpdateSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['member', 'employee', 'admin']);
    const { id } = await context.params;

    const product = await prisma.products.findUnique({
      where: { id },
      include: { category: { select: { name: true } } },
    });
    if (!product) {
      throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${id}`);
    }

    return {
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
      availableQty: availableQty({
        stock_qty: product.stock_qty,
        reserved_qty: product.reserved_qty,
      }),
      offlineSafetyQty: product.offline_safety_qty,
      imageUrl: product.image_url,
      isActive: product.is_active,
    };
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, productUpdateSchema);

    const existing = await prisma.products.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${id}`);
    }

    // A price change must not quietly rewrite what an open pre-order owes, so
    // the order freezes prices at placement (see orders.priceCart).
    //
    // The write goes through the barcode rule, and names *this* product as the one
    // the rule should ignore — a form that saves an unchanged row must not report
    // that row as a clash with itself. The id comes from the row we just read rather
    // than from the URL, so it is the canonical one however the caller spelled it.
    const updated = await writeProductWithBarcode(
      body.barcode,
      () =>
        prisma.products.update({
          where: { id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.categoryId !== undefined ? { category_id: body.categoryId } : {}),
            ...(body.barcode !== undefined ? { barcode: body.barcode } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.costPrice !== undefined ? { cost_price: body.costPrice } : {}),
            ...(body.salePrice !== undefined ? { sale_price: body.salePrice } : {}),
            ...(body.offlineSafetyQty !== undefined
              ? { offline_safety_qty: body.offlineSafetyQty }
              : {}),
            ...(body.imageUrl !== undefined ? { image_url: body.imageUrl } : {}),
            ...(body.isActive !== undefined ? { is_active: body.isActive } : {}),
          },
        }),
      { exceptProductId: existing.id },
    );

    return {
      id: updated.id,
      name: updated.name,
      salePrice: fromDecimal(updated.sale_price),
      isActive: updated.is_active,
    };
  });
}

/**
 * Soft delete.
 *
 * Products are never hard-deleted: `order_items.product_id` references them and
 * a past receipt must still resolve. Deactivating hides the product from the
 * till and the shop while keeping history intact.
 */
export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const { id } = await context.params;

    const existing = await prisma.products.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('ไม่พบสินค้าที่ระบุ', `Product ${id}`);
    }

    const updated = await prisma.products.update({
      where: { id },
      data: { is_active: false },
    });

    notifyStockChanged({
      productId: updated.id,
      name: updated.name,
      stockQty: updated.stock_qty,
      reservedQty: updated.reserved_qty,
      availableQty: availableQty({
        stock_qty: updated.stock_qty,
        reserved_qty: updated.reserved_qty,
      }),
    });

    return { id: updated.id, isActive: updated.is_active };
  });
}
