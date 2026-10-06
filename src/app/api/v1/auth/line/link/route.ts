/**
 * `POST /api/v1/auth/line/link` — finish a first LINE sign-in (ADR 0030 §1).
 *
 * The mirror of `POST /api/v1/auth/signup`, with one deliberate difference: the
 * number here is **proved**, not typed. A Google first sign-in may collect a
 * number because a wrong one merely strands the customer; a LINE first sign-in is
 * a *binding* act — it attaches a second door to a row that may already hold
 * points and history — so attaching on a typed number would be the takeover ADR
 * 0020 §4 exists to refuse. The OTP consumed here is the same challenge the
 * phone change uses, sent to the number being anchored to, and the whole rule
 * lives in `line-identity.ts`, which the tests drive directly.
 *
 * Unauthenticated by necessity; what bounds it is that the id token must be
 * genuinely LINE's and the code must match a challenge sent to the number — and
 * the limiter slows the walk between the two.
 */
import { readJson, withApi } from '@/lib/api';
import { startSession } from '@/lib/auth';
import { verifyLineIdToken } from '@/lib/line-id-token';
import { bindLineToCustomer } from '@/lib/line-identity';
import { chargeRateLimit } from '@/lib/rate-limit';
import { homePathForRole } from '@/lib/roles';
import { lineLinkSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await chargeRateLimit(request, 'line_link');

    const { idToken, phone, code, fullName, noticeVersion } = await readJson(request, lineLinkSchema);
    const identity = await verifyLineIdToken(idToken);

    const customer = await bindLineToCustomer({
      subject: identity.subject,
      displayName: identity.displayName,
      email: identity.email,
      phone,
      code,
      fullName,
      noticeVersion,
    });

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
      created: customer.created,
      redirectTo: homePathForRole('member'),
    };
  });
}
