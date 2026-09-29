/**
 * Customers, from two sides.
 *
 *   * **GET** is the till's lookup: staff-only, and it returns the minimum needed
 *     to attach a customer to a sale and read their points — no email, nothing a
 *     cashier has no reason to see. This is how SRS §5 loyalty gets wired to a
 *     walk-in sale.
 *   * **POST** enrols somebody (ADR 0010, ADR 0011), and staff may reach it as
 *     well as managers: at a shop in Thailand the person standing opposite the
 *     customer is a cashier, and sending them to the back office is how a
 *     counter-side sign-up stops happening. The capability is bounded elsewhere
 *     and not here — `createMember` forces the role, so the widest thing this
 *     route can be used to make is a *member*, and the account it mints carries
 *     no way to be promoted into staff.
 *
 *     **PATCH stays admin-only.** Adding a customer is a counter act; editing
 *     one, resetting a password or closing an account is office work, and the
 *     two belong to different surfaces for the same reason the till's own
 *     customer lookup returns four fields and the back office sees the list.
 *
 *     The customer list the admin screen shows is loaded server-side by the
 *     page, so there is no GET for it here — one projection is for a cashier,
 *     the other is for a manager, and a route that tried to be both would have
 *     to guess from the query string.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { createMember } from '@/lib/members';
import { memberCreateSchema } from '@/lib/schemas';

/**
 * Member lookup for the till.
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

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['employee', 'admin']);
    const body = await readJson(request, memberCreateSchema);

    return createMember({ ...body, actorId: session.id });
  });
}
