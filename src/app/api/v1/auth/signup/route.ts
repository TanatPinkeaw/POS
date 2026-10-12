/**
 * `POST /api/v1/auth/signup` — become a customer with Google (ADR 0020 §3, §1 amended).
 *
 * The single call that finishes a first Google sign-in. It carries the *proof* of the
 * Google account and the phone, and the proof depends on which shape Google's button gave
 * the device (`google-door.ts`):
 *
 *   * **popup** — the browser holds an id token from Google's JavaScript callback and posts
 *     it here, where it is re-verified. This is the desktop path, unchanged.
 *   * **redirect** — the browser never saw the token: Google POSTed it to
 *     `/api/v1/auth/google/redirect`, which verified it and left a short-lived httpOnly
 *     handoff instead (`google-pending.ts`). The handoff arrives on the same POST as the
 *     phone, because a cookie is sent with every request to this origin.
 *
 * Either way this function ends with one `GoogleIdentity`, and `identity.ts` decides what
 * may become a customer — there is no second rule for the second road, which is the point
 * of `provedGoogleIdentity` below.
 *
 * Unauthenticated by necessity. What bounds it is that Google must have vouched for the
 * account: nobody makes a row without an id token Google signed for this deployment's
 * client id, or a handoff this server minted after verifying exactly such a token. The
 * number it arrives with is not proof of anything (ADR 0020 §5), so a number that already
 * has a customer is refused rather than linked — see `identity.ts`.
 *
 * `noticeVersion` travels in the body and is checked in `identity.ts`, not here, because
 * only that function knows whether this request is creating an account or signing a
 * returning one in. A returning customer was told the notice when they arrived.
 */
import { cookies } from 'next/headers';

import { ok, readJson, withApi } from '@/lib/api';
import { startSession } from '@/lib/auth';
import { type GoogleIdentity, verifyGoogleIdToken } from '@/lib/google-id-token';
import {
  GOOGLE_PENDING_COOKIE,
  GooglePendingError,
  verifyGooglePendingToken,
} from '@/lib/google-pending';
import { completeCustomerGoogleSignIn } from '@/lib/identity';
import { homePathForRole } from '@/lib/roles';
import { googleSignupSchema } from '@/lib/schemas';

/**
 * The Google account this caller has proved, from whichever half of the flow carried it.
 *
 * The order is stated rather than inferred — an id token when the caller has one, else the
 * handoff cookie the landing set — for the reason `line/link` records: neither is a
 * parameter the caller chooses, so the proof is whichever credential is actually present.
 * A caller holding an id token is a popup flow and needs no cookie; a caller holding only
 * the handoff is a redirect flow that has just come back from Google's own page.
 */
async function provedGoogleIdentity(idToken: string | undefined): Promise<GoogleIdentity> {
  if (idToken !== undefined) {
    return verifyGoogleIdToken(idToken);
  }

  const store = await cookies();
  const handoff = store.get(GOOGLE_PENDING_COOKIE)?.value;
  if (!handoff) {
    /*
     * No proof at all: the same answer as an expired one, because the customer's next move
     * is identical — press the Google button again. Logged, though, and not for symmetry:
     * a handoff cookie that a browser refuses to attach to this POST is the one failure of
     * the redirect road that looks exactly like every other one from the customer's side
     * ("it still asks me for my number"), and this line is what tells the two apart.
     */
    console.warn('[google] signup had neither an id token nor a pending handoff cookie');
    throw new GooglePendingError();
  }

  try {
    const pending = await verifyGooglePendingToken(handoff);
    return {
      subject: pending.subject,
      email: pending.email,
      emailVerified: pending.emailVerified,
      fullName: pending.displayName,
    };
  } catch (error) {
    console.warn('[google] signup carried a pending handoff that did not verify');
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const { idToken, phone, fullName, noticeVersion } = await readJson(
      request,
      googleSignupSchema,
    );

    const identity = await provedGoogleIdentity(idToken);
    const customer = await completeCustomerGoogleSignIn({
      identity,
      phone,
      fullName,
      noticeVersion,
    });

    await startSession({
      id: customer.id,
      role: 'member',
      fullName: customer.fullName,
      phone: customer.phone,
    });

    const response = ok({
      id: customer.id,
      role: 'member',
      fullName: customer.fullName,
      pointsBalance: customer.pointsBalance,
      created: customer.created,
      redirectTo: homePathForRole('member'),
    });

    /*
     * The handoff has been spent, so it is cleared rather than left to expire: a second POST
     * from the same browser should not be able to re-attach the same Google account with a
     * different number. A *failed* attempt deliberately leaves it alone — a number the shop
     * refuses is worth retrying on the same screen, and the handoff is what makes that
     * possible.
     */
    response.cookies.delete(GOOGLE_PENDING_COOKIE);
    return response;
  });
}
