/**
 * Area layout helper.
 *
 * Every area layout needs the same three things: a session, a permission check,
 * and the user's display details. Doing it here means a new area is one line
 * rather than a copy of the same redirect dance.
 */
import { redirect } from 'next/navigation';

import type { ShellUser } from '@/components/shell/AppShell';

import { getSessionUser } from './auth';
import { prisma } from './db';
import { homePathForRole, type Role } from './roles';
import { loadShop } from './shop';
import { shopDisplayName } from './shop-view';

/**
 * Resolves the signed-in user for a layout, redirecting when they are not
 * allowed here. `middleware.ts` already guards these paths; this is the second
 * line of defence, at the point where the data is actually sent.
 */
export async function requireShellUser(allowed: Role[]): Promise<ShellUser> {
  const session = await getSessionUser();
  if (!session) {
    redirect('/login');
  }
  if (!allowed.includes(session.role)) {
    redirect(homePathForRole(session.role));
  }

  const [user, shop] = await Promise.all([
    prisma.users.findUnique({
      where: { id: session.id },
      select: { full_name: true, role: true, points_balance: true, is_active: true },
    }),
    // The shell prints the shop's name, so it is loaded with the user rather
    // than by each layout separately.
    loadShop(),
  ]);

  if (!user || !user.is_active) {
    redirect('/login');
  }

  return {
    id: session.id,
    fullName: user.full_name,
    role: user.role as Role,
    pointsBalance: user.points_balance,
    shopName: shopDisplayName(shop),
  };
}
