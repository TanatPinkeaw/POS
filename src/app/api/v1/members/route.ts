import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';

/**
 * Member lookup for the till.
 *
 * Staff-only, and it returns the minimum needed to attach a customer to a sale
 * and read their points: no email, no address, nothing a cashier has no reason
 * to see. This is how SRS §5 loyalty gets wired to a walk-in sale.
 */
export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireRole(['employee', 'admin']);

    const params = new URL(request.url).searchParams;
    const phone = params.get('phone')?.trim();
    const search = params.get('search')?.trim();

    if (!phone && !search) {
      return [];
    }

    const members = await prisma.users.findMany({
      where: {
        role: 'member',
        is_active: true,
        ...(phone ? { phone } : {}),
        ...(search
          ? {
              OR: [
                { phone: { contains: search } },
                { full_name: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: { id: true, full_name: true, phone: true, points_balance: true },
      orderBy: { full_name: 'asc' },
      take: 10,
    });

    return members.map((member) => ({
      id: member.id,
      fullName: member.full_name,
      phone: member.phone,
      pointsBalance: member.points_balance,
    }));
  });
}
