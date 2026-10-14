/**
 * The operator's half of the Google door: is the address this deployment hands Google
 * actually registered on its OAuth client? (ADR 0020 §1, amended)
 *
 * **The failure this answers, as it happened.** A customer opened the shop's link inside an
 * in-app browser on a phone, pressed **ดำเนินการต่อด้วย Google**, and never reached us at
 * all: Google answered with its own page — "การเข้าถึงถูกบล็อก: คำขอของแอปนี้ไม่ถูกต้อง"
 * and "ข้อผิดพลาด 400: redirect_uri_mismatch". The shop's own server saw nothing, so the
 * only evidence in the world was a screenshot, and the code on the deployment was already
 * correct: the page handed Google exactly `googleRedirectLoginUri(publicBase)`. What was
 * missing was one line in a console nobody here can open.
 *
 * **Google can be asked that question directly, and this module is where the question and
 * the answer are decided.** Its authorize endpoint refuses an unregistered `redirect_uri`
 * *before* it shows anybody anything, so the deployment can send the very address its button
 * carries and read Google's verdict — no account, no session, no customer. That is the same
 * check Google performs when the customer presses the button, which is why it is evidence
 * rather than a guess. `scripts/google-check.ts` is the I/O half.
 *
 * Measured on this deployment's own client, for the record (2026-10-12):
 *
 *   https://pos.tanatpinkeaw.stream/api/v1/auth/google/redirect    → error page, redirect_uri_mismatch
 *   https://pos.tanatpinkeaw.stream/api/v1/auth/google/redirect/   → error page, redirect_uri_mismatch
 *   https://a-host-that-does-not-exist.example/api/v1/auth/google/redirect → error page, invalid_request
 *
 * The first two lines are the finding: the entry was **missing**, not misspelled — a
 * trailing slash was not hiding a registered variant. The third is why the answer is *read*
 * rather than guessed at: Google names a host it cannot accept at all (`invalid_request`)
 * differently from a host it has simply never been told about (`redirect_uri_mismatch`), so
 * the two mistakes an operator can make look different on this side too.
 *
 * **What this cannot prove, stated rather than implied.** Google's list is not readable:
 * there is no API that returns an OAuth client's authorized redirect URIs (the IAM
 * `oauthClients` resource is a different thing entirely), so `registered` is the *absence*
 * of an error page and not a reading of the list — and the happy path is the one branch this
 * checkout cannot rehearse, because no client here has a registered URI to point at. It
 * rests on Google's own ordering, which the two failure branches above demonstrate: the URI
 * is validated before a sign-in screen is shown. And the *origin* entry is a separate fact
 * this cannot see; a missing one paints no button, which `CustomerSignIn` already says out
 * loud on the screen itself.
 */

/** Google's authorization endpoint, used here as a validator rather than a way in. */
export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Where Google **leaves** a request it refuses at this stage.
 *
 * Not decoration: it is the discriminator. A request Google accepted walks on to its own
 * sign-in screen (`/v3/signin/...`), and a request it refused is parked on this path with the
 * reason in the query string.
 */
export const GOOGLE_ERROR_PATH = '/signin/oauth/error';

/**
 * The codes worth naming. Google answers in a base64 protobuf blob, so the code is found by
 * looking for these inside the decoded bytes — a closed list, because an unrecognised code
 * has to read as *unrecognised* rather than as the one we expected.
 */
export const GOOGLE_ERROR_CODES = [
  'redirect_uri_mismatch',
  'invalid_client',
  'invalid_request',
  'disallowed_useragent',
  'unauthorized_client',
  'access_denied',
  'admin_policy_enforced',
] as const;

/**
 * The request that asks Google one question: would you accept this `redirect_uri` for this
 * client?
 *
 * Deliberately the shape the customer's own navigation takes — `response_type=code`, the
 * same client, the same address — because the point is to be refused for the same reason
 * Google refuses them, if it is going to. Nothing here starts a sign-in: the response is
 * never exchanged, no account is chosen and no code is stored.
 */
export function googleRegistrationProbeUrl(input: {
  clientId: string;
  redirectUri: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  return url.toString();
}

/**
 * What Google's answer means, as a closed set of four.
 *
 * `unmeasured` is the one that matters most: an answer this function does not recognise —
 * a captcha, a maintenance page, a 200 from somewhere else entirely — is *not* a pass. The
 * whole reason this module exists is that "no error page" was being read as success for a
 * round too long.
 */
export type GoogleRegistrationVerdict =
  | { kind: 'registered' }
  | { kind: 'not-registered' }
  | { kind: 'refused'; code: string }
  | { kind: 'unmeasured' };

/**
 * Read Google's answer.
 *
 * The order is the reading: an error page is the only place a verdict comes from, the code
 * inside it decides which verdict, and everything else is either Google's sign-in screen —
 * which it shows only after the address passed — or something this function declines to
 * interpret.
 */
export function readGoogleRegistrationVerdict(input: {
  finalUrl: string;
  body?: string;
}): GoogleRegistrationVerdict {
  let url: URL;
  try {
    url = new URL(input.finalUrl);
  } catch {
    return { kind: 'unmeasured' };
  }

  if (!url.pathname.startsWith(GOOGLE_ERROR_PATH)) {
    /*
     * Google's sign-in and consent screens are the paths it reaches *after* validating the
     * redirect URI, so reaching one is the pass. Anything that is not Google, or a Google
     * path that is neither — `/sorry/index` is a captcha — stays unmeasured, because a
     * deployment that guessed "fine" from a captcha would be back to a screenshot.
     *
     * **A path carrying `error` is excluded from the pass, deliberately.** The refusal path
     * above is the one this deployment has seen, and if Google parks a refusal anywhere else
     * the "a Google page whose path mentions signin" rule would read it as *registered* — a
     * green run while the door stays shut on every phone. An error page this function has not
     * been taught is an answer it does not recognise, which by its own rule is not a pass.
     */
    const isGoogleSignIn =
      url.hostname === 'google.com' || url.hostname.endsWith('.google.com');
    return isGoogleSignIn && url.pathname.includes('/signin') && !url.pathname.includes('/error')
      ? { kind: 'registered' }
      : { kind: 'unmeasured' };
  }

  const code = googleErrorCodeIn(url, input.body);
  if (code === null) {
    return { kind: 'unmeasured' };
  }
  // The one code with its own answer: Google is telling us it has never been told about this
  // address, which is a console entry rather than a mistake in the address itself.
  return code === 'redirect_uri_mismatch' ? { kind: 'not-registered' } : { kind: 'refused', code };
}

/**
 * The reason Google parked the request, out of the query string first and the body second.
 *
 * The query string is the answer Google gives a *browser* (`authError=`, a base64 protobuf
 * whose bytes carry the code as plain ASCII — decoding with `latin1` keeps those bytes
 * byte-for-byte). The body is the fallback for an answer that arrives without it: Google's
 * error page prints the code as its own text, which is what a human reads off the screen the
 * customer photographed.
 */
function googleErrorCodeIn(url: URL, body: string | undefined): string | null {
  const encoded = url.searchParams.get('authError');
  if (encoded !== null && encoded.length > 0) {
    const decoded = Buffer.from(encoded, 'base64').toString('latin1');
    const named = GOOGLE_ERROR_CODES.find((code) => decoded.includes(code));
    if (named !== undefined) {
      return named;
    }
  }
  return GOOGLE_ERROR_CODES.find((code) => (body ?? '').includes(code)) ?? null;
}
