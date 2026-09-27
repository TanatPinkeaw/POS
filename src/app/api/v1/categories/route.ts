import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { categoryCreateSchema } from '@/lib/schemas';

/** Categories are readable by anyone signed in; the catalogue UI needs them. */
export async function GET(): Promise<Response> {
  return withApi(async () => {
    await requireRole(['member', 'employee', 'admin']);
    return prisma.categories.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['admin']);
    const { name } = await readJson(request, categoryCreateSchema);
    return prisma.categories.create({ data: { name } });
  });
}
