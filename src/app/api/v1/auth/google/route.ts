/**
 * `POST /api/v1/auth/google` — continue with Google (ADR 0020 §1, §6).
 *
 * The id token is verified in-process (`google-id-token.ts`); nothing is trusted for
 * having arrived over TLS. Then one of two things is true:
 *
 *   * **The Google account is already a customer.** Start a session and answer like
 *     the password door does. No code is asked for — the phone is proved when it
 *     *changes*, never at signup or on an ordinary sign-in (ADR 0020 §5).
 *   * **It is not.** Answer `needsPhone: true` and let the browser collect a phone,
 *     which `POST /api/v1/auth/signup` completes in one call. Deliberately *nothing* is
 *     written here: there is no half-created customer and no pending identity on the
 *     server, so a caller who walks away leaves no row behind.
 *
 * A Google account that is not a customer can therefore probe this door harmlessly —
 * the answer for an unknown subject is the same shape as for any other, and the id
 * token has to be genuinely Google's before it is answered at all.
 */
import { readJson, withApi } from '@/lib/api';
import { startSession } from '@/lib/auth';
import { UnauthenticatedError } from '@/lib/errors';
import { verifyGoogleIdToken } from '@/lib/google-id-token';
import { findCustomerByGoogleSubject } from '@/lib/identity';
import { homePathForRole } from '@/lib/roles';
import { googleSignInSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const { idToken } = await readJson(request, googleSignInSchema);
    const identity = await verifyGoogleIdToken(idToken);

    const customer = await findCustomerByGoogleSubject(identity.subject);
    if (!customer) {
      // Not a customer yet: the browser must prove a phone (ADR 0020 §3).
      return {
        needsPhone: true,
        fullName: identity.fullName,
        email: identity.email,
      };
    }

    if (!customer.isActive) {
      throw new UnauthenticatedError('บัญชีนี้ถูกปิดการใช้งานแล้ว');
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
      pointsBalance: customer.pointsBalance,
      redirectTo: homePathForRole('member'),
    };
  });
}
