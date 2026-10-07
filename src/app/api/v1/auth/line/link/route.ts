/**
 * `POST /api/v1/auth/line/link` — finish a first LINE sign-in (ADR 0030 §1, amended).
 *
 * The mirror of `POST /api/v1/auth/signup`, with one deliberate difference: the number
 * here is **proved**, not typed. A Google first sign-in may collect a number because a
 * wrong one merely strands the customer; a LINE first sign-in is a *binding* act — it
 * attaches a second door to a row that may already hold points and history — so attaching
 * on a typed number would be the takeover ADR 0020 §4 exists to refuse. The OTP consumed
 * here is the same challenge the phone change uses, sent to the number being anchored to,
 * and the whole rule lives in `line-identity.ts`, which the tests drive directly.
 *
 * The proof of the **LINE account** arrives in one of two shapes: an `idToken` the browser
 * holds (the in-app surface), or the short-lived httpOnly handoff the redirect flow left
 * behind when it came back with a verified subject and nowhere to put it (`line-pending.ts`).
 * The id token is preferred when present, and the handoff is the fallback for the browser
 * that has none — a fixed order rather than a mixture, so which credential was accepted is
 * one line to read. (A browser can hold both: a handoff from an abandoned LINE press and an
 * id token from a later one. Refusing that combination would fail a customer for something
 * they cannot see, which is why the rule is an order rather than an exclusivity check.)
 * Before the handoff existed, only the id token did, so the front door's LINE button could
 * never finish a first sign-in at all — which is the loop the customer reported.
 *
 * Unauthenticated by necessity; what bounds it is that the LINE proof must be genuinely
 * LINE's and the code must match a challenge sent to the number — and the limiter slows
 * the walk between the two.
 */
import { cookies } from 'next/headers';

import { ok, readJson, withApi } from '@/lib/api';
import { startSession } from '@/lib/auth';
import { verifyLineIdToken } from '@/lib/line-id-token';
import { bindLineToCustomer } from '@/lib/line-identity';
import {
  LINE_PENDING_COOKIE,
  LinePendingError,
  type LinePendingIdentity,
  verifyLinePendingToken,
} from '@/lib/line-pending';
import { chargeRateLimit } from '@/lib/rate-limit';
import { homePathForRole } from '@/lib/roles';
import { lineLinkSchema } from '@/lib/schemas';

/**
 * The LINE account this caller has proved, from whichever half of the flow carried it.
 *
 * The order is stated rather than inferred: an id token when the caller has one, else the
 * handoff cookie the callback set. Neither is a *parameter* the caller chooses, which is the
 * point — the proof is whichever credential is actually present, the same rule the roles here
 * follow.
 */
async function provedLineIdentity(idToken: string | undefined): Promise<LinePendingIdentity> {
  if (idToken !== undefined) {
    const identity = await verifyLineIdToken(idToken);
    return {
      subject: identity.subject,
      displayName: identity.displayName,
      email: identity.email,
    };
  }

  const store = await cookies();
  const handoff = store.get(LINE_PENDING_COOKIE)?.value;
  if (!handoff) {
    // No proof at all: the same answer as an expired one, because the customer's next
    // move is identical — press the LINE button again.
    throw new LinePendingError();
  }

  return verifyLinePendingToken(handoff);
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    await chargeRateLimit(request, 'line_link');

    const { idToken, phone, code, fullName, noticeVersion } = await readJson(
      request,
      lineLinkSchema,
    );
    const identity = await provedLineIdentity(idToken);

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

    /*
     * The handoff has been spent, so it is cleared rather than left to expire: a second
     * POST from the same browser should not be able to re-attach the same subject with a
     * different number. A *failed* attempt deliberately leaves it alone, because a mistyped
     * OTP must be retryable on the same screen — the challenge's own attempt budget is what
     * bounds that, not this cookie.
     */
    const response = ok({
      id: customer.id,
      role: 'member',
      fullName: customer.fullName,
      created: customer.created,
      redirectTo: homePathForRole('member'),
    });
    response.cookies.delete(LINE_PENDING_COOKIE);
    return response;
  });
}
