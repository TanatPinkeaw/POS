import { withApi, readJson } from '@/lib/api';
import { startSession, verifyPassword } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { UnauthenticatedError } from '@/lib/errors';
import { homePathForRole, type Role } from '@/lib/roles';
import { loginSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const { identifier, password } = await readJson(request, loginSchema);

    const user = await prisma.users.findFirst({
      where: { OR: [{ phone: identifier }, { email: identifier }] },
    });

    const passwordOk = user ? await verifyPassword(password, user.password_hash) : false;

    if (!user || !passwordOk) {
      // One message for both cases: telling the caller which half was wrong
      // would let them enumerate who has an account.
      throw new UnauthenticatedError('Incorrect phone number/email or password');
    }

    if (!user.is_active) {
      throw new UnauthenticatedError('This account has been deactivated');
    }

    const role = user.role as Role;
    await startSession({
      id: user.id,
      role,
      fullName: user.full_name,
      phone: user.phone,
    });

    return {
      id: user.id,
      role,
      fullName: user.full_name,
      pointsBalance: user.points_balance,
      redirectTo: homePathForRole(role),
    };
  });
}
