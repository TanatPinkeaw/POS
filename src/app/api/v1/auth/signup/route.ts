/**
 * `POST /api/v1/auth/signup` — become a customer, or link to the one you already are
 * (ADR 0020 §3, §4).
 *
 * The single call that finishes a first Google sign-in. It carries the id token
 * again (re-verified here) rather than a pending identity held server-side, so there
 * is no window in which a Google credential exists without a phone to anchor it — and
 * the whole rule for whether that phone makes a new customer or links to one lives in
 * `identity.ts`, which the tests drive directly.
 *
 * Unauthenticated by necessity, and covered by the OTP it requires: the code could
 * only have been obtained by sending through the rate-limited, cost-bearing send door
 * first, so account creation is bounded by the same ceiling that bounds texting. A
 * wrong or expired code is refused (422) before anything is written.
 */
import { readJson, withApi } from '@/lib/api';
import { startSession } from '@/lib/auth';
import { verifyGoogleIdToken } from '@/lib/google-id-token';
import { completeCustomerGoogleSignIn } from '@/lib/identity';
import { homePathForRole } from '@/lib/roles';
import { googleSignupSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const { idToken, phone, code, fullName } = await readJson(request, googleSignupSchema);

    const identity = await verifyGoogleIdToken(idToken);
    const customer = await completeCustomerGoogleSignIn({ identity, phone, code, fullName });

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
      linked: customer.linked,
      redirectTo: homePathForRole('member'),
    };
  });
}
