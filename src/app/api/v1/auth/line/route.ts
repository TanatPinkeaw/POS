/**
 * `POST /api/v1/auth/line` — continue with LINE (ADR 0030 §1).
 *
 * The mirror of `POST /api/v1/auth/google`, in the shape ADR 0020 established:
 * the id token is verified in process (`line-id-token.ts`), then one of two
 * things is true —
 *
 *   * **The LINE account is already a customer.** Start a session and answer
 *     like the password door does.
 *   * **It is not.** Answer `needsPhone: true` and let the browser collect a
 *     phone and an OTP code, which `POST /api/v1/auth/line/link` completes.
 *     Deliberately nothing is written here: no half-created customer, no pending
 *     identity on the server, so a caller who walks away leaves no row behind.
 *
 * Unauthenticated by necessity — it is a sign-in door — and bounded like every
 * other unauthenticated door: a LINE subject cannot be invented (the token has
 * to be genuinely LINE's), but the *attempt* to walk the door is what the
 * limiter slows.
 */
import { readJson, withApi } from '@/lib/api';
import { startSession } from '@/lib/auth';
import { UnauthenticatedError } from '@/lib/errors';
import { verifyLineIdToken } from '@/lib/line-id-token';
import { findCustomerByLineSubject } from '@/lib/line-identity';
import { chargeRateLimit } from '@/lib/rate-limit';
import { homePathForRole } from '@/lib/roles';
import { lineSignInSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await chargeRateLimit(request, 'line_signin');

    const { idToken } = await readJson(request, lineSignInSchema);
    const identity = await verifyLineIdToken(idToken);

    const customer = await findCustomerByLineSubject(identity.subject);
    if (!customer) {
      // Not a customer yet: the browser must prove a phone by OTP (ADR 0030 §1).
      return {
        needsPhone: true,
        fullName: identity.displayName,
        email: identity.email,
      };
    }

    if (!customer.isActive) {
      throw new UnauthenticatedError('บัญชีนี้ถูกปิดการใช้งานแล้ว');
    }

    if (customer.role !== 'member') {
      // LINE is a customer door; a staff row keeps its own door (ADR 0030 §1).
      throw new UnauthenticatedError('บัญชีพนักงานใช้เบอร์โทรและรหัสผ่านเข้าสู่ระบบ');
    }

    await startSession({
      id: customer.id,
      role: 'member',
      fullName: customer.fullName,
      phone: customer.phone,
    });

    return {
      id: customer.id,
      role: 'member',
      fullName: customer.fullName,
      redirectTo: homePathForRole('member'),
    };
  });
}
