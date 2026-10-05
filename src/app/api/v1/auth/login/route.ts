/**
 * Signing in.
 *
 * The one endpoint where a wrong answer is worth counting: a password is guessed
 * by volume, and nothing else in this app can be attacked that way without already
 * holding a session. Two buckets are spent on a failure, and they answer different
 * questions — `login_failure` is "is this account being guessed at" (keyed by the
 * address *and* the identifier, so one angry customer cannot lock out a colleague
 * on the same wifi), and `login_flood` is "is this door being hammered" (keyed by
 * the address alone, which is what a spray across many identifiers spends).
 *
 * Only failures are charged. A successful sign-in costs the caller nothing, which
 * is the difference between a limiter that protects a shop and one that locks out
 * an office on a Monday morning.
 */
import { withApi, readJson } from '@/lib/api';
import { startSession, verifyPassword } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { UnauthenticatedError } from '@/lib/errors';
import { chargeRateLimit } from '@/lib/rate-limit';
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
      // Charged before the refusal, and after the password check: what is being
      // limited is the *guess*, so the limiter must not be the thing that tells a
      // caller whether the account exists.
      await chargeRateLimit(request, 'login_flood');
      await chargeRateLimit(request, 'login_failure', identifier);

      // One message for both cases: telling the caller which half was wrong
      // would let them enumerate who has an account.
      throw new UnauthenticatedError('เบอร์โทร อีเมล หรือรหัสผ่านไม่ถูกต้อง');
    }

    if (!user.is_active) {
      throw new UnauthenticatedError('บัญชีนี้ถูกปิดการใช้งานแล้ว');
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
