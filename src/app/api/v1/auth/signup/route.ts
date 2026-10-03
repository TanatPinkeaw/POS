/**
 * `POST /api/v1/auth/signup` — become a customer with Google (ADR 0020 §3).
 *
 * The single call that finishes a first Google sign-in. It carries the id token again
 * (re-verified here) rather than a pending identity held server-side, so there is no
 * window in which a Google credential exists without a phone to anchor it — and the
 * whole rule for whether that phone makes a new customer lives in `identity.ts`, which
 * the tests drive directly.
 *
 * Unauthenticated by necessity. What bounds it is that Google must have issued the
 * token: nobody makes an account without a Google account Google will vouch for. The
 * number it arrives with is not proof of anything (ADR 0020 §5), so a number that
 * already has a customer is refused rather than linked — see `identity.ts`.
 */
import { readJson, withApi } from '@/lib/api';
import { startSession } from '@/lib/auth';
import { verifyGoogleIdToken } from '@/lib/google-id-token';
import { completeCustomerGoogleSignIn } from '@/lib/identity';
import { homePathForRole } from '@/lib/roles';
import { googleSignupSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const { idToken, phone, fullName } = await readJson(request, googleSignupSchema);

    const identity = await verifyGoogleIdToken(idToken);
    const customer = await completeCustomerGoogleSignIn({ identity, phone, fullName });

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
      created: customer.created,
      redirectTo: homePathForRole('member'),
    };
  });
}
