/**
 * `POST /api/v1/account/line` — the customer's own LINE binding (ADR 0030 §1, §2).
 *
 * Three acts on one door, distinguished by the body rather than by three routes,
 * because they are three buttons on one card of the account page:
 *
 *   * **`{ idToken }` — bind.** The customer is *signed in already*, so no phone
 *     and no OTP is needed: the session is the proof of who the row is, and the
 *     LINE id token (verified here) is the proof of which LINE account is being
 *     attached. A typed number would be the takeover ADR 0020 §4 refuses; a
 *     session row is not a typed number. Consent to be notified is recorded at
 *     the same moment, because a customer who just linked their LINE to the shop
 *     has said yes in the only sentence that matters.
 *   * **`{ unlink: true }` — unbind.** The customer's own withdrawal: subject and
 *     consent clear together, which is the strongest form of "stop messaging me"
 *     (ADR 0030 §2). Nothing is demanded to stop being reachable.
 *   * **`{ consentOnly: true }` — re-consent.** A customer who withdrew
 *     notification but kept the binding, or whose consent predates the current
 *     text, says yes again. Binding is required: consent without an address is
 *     dead weight.
 *
 * `GET` on the same door is the card's own read — the callback redirects land on
 * the account page, which re-fetches this to show the binding as it now is.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { verifyLineIdToken } from '@/lib/line-id-token';
import {
  bindSignedInCustomer,
  lineBindingForUser,
  setLineNotificationConsent,
  unbindLineFromCustomer,
} from '@/lib/line-identity';
import { LINE_CONSENT_VERSION } from '@/lib/line-notify';
import { chargeRateLimit } from '@/lib/rate-limit';
import { z } from 'zod';

/** The body: an id token (bind), `unlink`, or `consentOnly`. */
const accountLineSchema = z
  .object({
    idToken: z.string().trim().min(1).optional(),
    unlink: z.literal(true).optional(),
    consentOnly: z.literal(true).optional(),
  })
  .refine((body) => !!(body.idToken || body.unlink || body.consentOnly), {
    message: 'one of idToken, unlink, consentOnly is required',
  });

export async function GET(): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member']);
    return lineBindingForUser(session.id);
  });
}

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['member']);
    await chargeRateLimit(request, 'line_link', session.id);

    const body = await readJson(request, accountLineSchema);

    if (body.unlink) {
      await unbindLineFromCustomer(session.id);
      return { lineSubject: null, consentAt: null, consentVersion: null };
    }

    if (body.consentOnly) {
      const result = await setLineNotificationConsent({
        userId: session.id,
        consentVersion: LINE_CONSENT_VERSION,
      });
      return { consentAt: result.consentAt, consentVersion: LINE_CONSENT_VERSION };
    }

    // Bind: the session names the row; the id token names the LINE account.
    const identity = await verifyLineIdToken(body.idToken as string);
    await bindSignedInCustomer({
      userId: session.id,
      subject: identity.subject,
    });

    return lineBindingForUser(session.id);
  });
}
