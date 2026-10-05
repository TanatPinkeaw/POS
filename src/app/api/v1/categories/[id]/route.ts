/**
 * Editing one category (ADR 0002).
 *
 * Deleting is refused while products still point at the category. The database
 * would refuse it anyway — the foreign key is `ON DELETE RESTRICT` — but a raw
 * constraint error tells a renter nothing, whereas "this category still has 14
 * products" tells them what to do next. The refusal is cheap because the count
 * is already needed to write that message.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { categoryRenameSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

/** Category ids are autoincrement integers, so a non-numeric id is simply wrong. */
function parseCategoryId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError(`"${raw}" ไม่ใช่รหัสหมวดหมู่ที่ถูกต้อง`);
  }
  return id;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const id = parseCategoryId((await context.params).id);
    const { name } = await readJson(request, categoryRenameSchema);

    const existing = await prisma.categories.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundError('ไม่พบหมวดหมู่ที่ระบุ', `Category ${id}`);
    }

    return prisma.categories.update({ where: { id }, data: { name } });
  });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const id = parseCategoryId((await context.params).id);

    const category = await prisma.categories.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!category) {
      throw new NotFoundError('ไม่พบหมวดหมู่ที่ระบุ', `Category ${id}`);
    }

    if (category._count.products > 0) {
      throw new ConflictError(
        `หมวดหมู่ "${category.name}" ยังมีสินค้าอยู่ ${category._count.products} รายการ ` +
          '— กรุณาย้ายสินค้าออกจากหมวดหมู่นี้ก่อน',
        'CATEGORY_IN_USE',
      );
    }

    await prisma.categories.delete({ where: { id } });
    return { deleted: true, id };
  });
}
