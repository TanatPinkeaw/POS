/**
 * `POST /api/v1/auth/google/redirect` — the endpoint Google's redirect-mode button
 * hands the credential to (ADR 0020 §1, amended).
 *
 * A phone gets Google's `redirect` UX mode and a desktop gets the `popup` (see
 * `google-door.ts` for why the mode is split by device, with Google's own words). That
 * split has one consequence that has to live somewhere: in redirect mode there is no
 * JavaScript callback, because the browser left the page. Google POSTs the credential to
 * the `login_uri` the button carried, as
 * `credential=<id token>&g_csrf_token=<value>` with
 * `Content-Type: application/x-www-form-urlencoded` — a *form* body, which is why this
 * route does not touch `readJson`, and a **page** cannot answer it, which is why it is a
 * route at all.
 *
 * Four things happen here, in this order, and the order is the security:
 *
 *   1. **The body is a form and both fields are present.** No `credential` is nothing to
 *      verify; no `g_csrf_token` is a request that never came from Google's own page.
 *   2. **`g_csrf_token` is compared with the cookie of the same name**, which is the
 *      double-submit Google's own HTML API documents
 *      (https://developers.google.com/identity/gsi/web/reference/html-reference). A
 *      mismatch is refused — that is a caller assembling a POST by hand.
 *   3. **The id token is verified** exactly as the popup path verifies it
 *      (`google-id-token.ts`: Google's JWKS, RS256, this deployment's client id). Nothing
 *      is trusted for having arrived over TLS. This is the authorisation; the CSRF check
 *      above is not.
 *   4. **The arrival is planned by a pure function** (`planGoogleArrival`) and carried
 *      out here.
 *
 * **The one deliberate softness, stated rather than hidden.** When the cookie is *absent*,
 * this route proceeds and writes an English line saying so. Whether a browser attaches a
 * cookie Google set for this origin to a *cross-site top-level POST* is not something this
 * deployment controls, and refusing on a missing cookie would invent a new phone-only
 * failure in the middle of a change whose whole purpose is to remove one — the id token
 * still has to verify against Google for our client id, so what is left unproven is only
 * a login-CSRF (a caller signing somebody into an account they control). The log line is
 * what turns that from a guess into something the shop's own server can answer.
 *
 * **Every answer is a 303, and not for style.** `NextResponse.redirect` defaults to 307,
 * which preserves the method and the body: the browser would POST this form again to the
 * page it was sent to, and a page route cannot receive a POST. 303 is the status that says
 * "go and *GET* that".
 *
 * Responses are redirects to a screen that can say what happened — the front door — never
 * a JSON body, for the reason the LINE callback records: the customer is in a browser that
 * just came back from a full-page POST, and JSON there is a wall of braces.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { withApi } from '@/lib/api';
import { startSession } from '@/lib/auth';
import { planGoogleArrival, googleLandingUrl } from '@/lib/google-door';
import { readGoogleClientId, type GoogleIdentity, verifyGoogleIdToken } from '@/lib/google-id-token';
import {
  GOOGLE_PENDING_COOKIE,
  createGooglePendingToken,
  googlePendingCookieOptions,
} from '@/lib/google-pending';
import { findCustomerByGoogleSubject } from '@/lib/identity';
import { publicBaseUrlOr } from '@/lib/public-url';
import { chargeRateLimit } from '@/lib/rate-limit';

/** Google's own CSRF cookie, which its button sets on this origin before the POST. */
const GOOGLE_CSRF_COOKIE = 'g_csrf_token';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    /*
     * Every landing is built on the deployment's public address, not the request's own
     * origin: behind the shop's tunnel this process sees `localhost:3000`, and a customer
     * sent there cannot reach the page the refusal is written on.
     */
    const base = publicBaseUrlOr(request.url);

    /*
     * The one place a failure leaves by, so no branch can forget the log line. The stage it
     * names is the whole point of it: "the Google button does nothing on my phone" has no
     * other evidence, and `csrf-mismatch` and `credential` are different diagnoses.
     */
    const refused = (stage: string): Response => {
      console.warn(`[google] redirect landing refused at ${stage}`);
      return NextResponse.redirect(googleLandingUrl(base, 'error'), 303);
    };

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return refused('body');
    }

    const credential = form.get('credential');
    if (typeof credential !== 'string' || credential.length === 0) {
      return refused('no-credential');
    }

    const csrf = form.get('g_csrf_token');
    if (typeof csrf !== 'string' || csrf.length === 0) {
      return refused('csrf-missing');
    }

    const store = await cookies();
    const csrfCookie = store.get(GOOGLE_CSRF_COOKIE)?.value ?? null;
    if (csrfCookie !== null && csrfCookie !== csrf) {
      return refused('csrf-mismatch');
    }
    if (csrfCookie === null) {
      // Soft, and documented in the header: see "the one deliberate softness" above.
      console.warn('[google] redirect landing had no g_csrf_token cookie');
    }

    /*
     * Charged after the cheap structural checks and before the crypto, keyed by the
     * address like the other session-less doors (ADR 0009). The work behind this point is
     * a JWKS fetch and, on the sign-in path, a minted session.
     */
    if (readGoogleClientId() === null) {
      // No client id means no audience to verify against — `verifyGoogleIdToken` would say
      // so itself, but a door the shop has not configured is worth its own stage name.
      return refused('no-client-id');
    }
    await chargeRateLimit(request, 'google_redirect');

    let identity: GoogleIdentity;
    try {
      identity = await verifyGoogleIdToken(credential);
    } catch {
      return refused('credential');
    }

    // 4. Who, if anyone, already holds this Google account. The decision is pure and
    //    tested; this route is the adapter that carries it out.
    const customer = await findCustomerByGoogleSubject(identity.subject);
    const outcome = planGoogleArrival({ customer });

    switch (outcome.kind) {
      case 'sign-in': {
        if (customer === null) {
          // Unreachable — `planGoogleArrival` answers `needs-phone` with no customer — and a
          // redirect rather than a crash if that ever stops being true.
          return refused('incomplete');
        }
        await startSession({
          id: customer.id,
          role: 'member',
          fullName: customer.fullName,
          phone: customer.phone,
        });
        return NextResponse.redirect(`${base}${outcome.redirectTo}`, 303);
      }

      case 'needs-phone': {
        /*
         * A real Google proof that belongs to *this* browser goes back to it, in a cookie
         * no script can read and that expires in ten minutes. The phone step then posts a
         * number, which `identity.ts` decides about — prove, then decide, then write, the
         * order ADR 0020 §3 states.
         */
        const handoff = await createGooglePendingToken({
          subject: identity.subject,
          displayName: identity.fullName,
          email: identity.email,
          emailVerified: identity.emailVerified,
        });
        const response = NextResponse.redirect(googleLandingUrl(base, 'new'), 303);
        response.cookies.set(
          GOOGLE_PENDING_COOKIE,
          handoff,
          googlePendingCookieOptions(process.env.NODE_ENV === 'production'),
        );
        return response;
      }

      case 'refused': {
        return NextResponse.redirect(googleLandingUrl(base, outcome.reason), 303);
      }
    }
  });
}
