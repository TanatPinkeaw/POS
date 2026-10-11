/**
 * `GET /api/v1/auth/line/callback` — LINE sends the customer back here
 * (ADR 0030 §1, amended).
 *
 * One route, two doors, and the state it minted says which. The customer returns from
 * LINE's consent screen with `?code=…&state=…`; this route verifies the state, exchanges
 * the code for an **id token** (a POST from this server to LINE's token endpoint, over the
 * channel secret — the code is never trusted by itself), verifies that token the same way
 * the sign-in door does, and then does exactly one of four things:
 *
 *   * **This door binds** (`?intent=bind` from the account page) — the session is the
 *     takeover argument, so it binds the subject to the row the browser is signed in as,
 *     which is what `bindSignedInCustomer` records. No OTP, because the caller already
 *     holds the credential the phone change and the points ledger trust.
 *   * **This door signs in and knows the LINE account** — a session starts and the
 *     customer lands on the member home.
 *   * **This door signs in and the LINE account is nobody's** — the one case that needs a
 *     phone. Nothing is written here: the verified subject rides back to the customer's
 *     own browser in a short-lived httpOnly handoff (`line-pending.ts`), and the front door
 *     collects a number and an OTP before anything is attached. This is the half the
 *     original flow never had, which is why an unknown LINE account used to be handed a
 *     refusal it could not see.
 *   * **Refused** — a closed account, a staff row, or a binding with no member session.
 *
 * Two deliberate shapes, both unchanged:
 *
 *   * **The answer is a redirect, not a JSON.** The customer is in a browser that followed
 *     LINE's redirects; a JSON body would be a white page. Every answer lands on a screen
 *     that can say what happened — and every *refusal* lands on `/login`, because
 *     `/shop/account` needs a member session to render at all, so a refusal aimed there is
 *     a refusal nobody reads. That silent bounce was the loop, seen from the customer's
 *     side.
 *   * **Nothing half-created.** An unproved subject writes no row and no pending identity
 *     on the server: the handoff lives in the customer's own browser, so a caller who walks
 *     away leaves nothing behind.
 *
 * The third shape is the one a phone forced: **a failure earns one more walk through
 * LINE's screens**, with auto login switched off. A sign-in that works on the shop's
 * desktop and dies on a phone is LINE's documented auto-login failure — private browsing,
 * or an OS whose Universal Links did not fire — where LINE still calls this callback, with
 * a code that "is an invalid value, so you can't issue an access token", and a remedy that
 * is the second walk rather than "please try again" for the rest of time. It is bounded by
 * the `retried` claim in the state, so a failure that is *not* that can never loop.
 *
 * Every refusal also leaves a line in the log. That is not decoration: the whole point of
 * the failure above is that it does not happen on a desktop at all, so a report of "it
 * doesn't work on my phone" arrives with nothing on the server to read, and the stage —
 * `code-exchange`, `line-error`, `credential`, `state` — is the difference between a
 * remedy and another guess.
 */
import { NextResponse } from 'next/server';

import { withApi } from '@/lib/api';
import { getSessionUser, startSession } from '@/lib/auth';
import { ConflictError } from '@/lib/errors';
import {
  type LineArrivalFailure,
  type LineIntent,
  buildLineAuthorizeUrl,
  lineLandingFor,
  lineLandingUrl,
  lineRedirectUri,
  planLineArrival,
  planLineRetry,
} from '@/lib/line-door';
import {
  InvalidLineCredentialError,
  type LineIdentity,
  readLineChannelId,
  readLineTokenUrl,
  verifyLineIdToken,
} from '@/lib/line-id-token';
import { bindSignedInCustomer, findCustomerByLineSubject } from '@/lib/line-identity';
import {
  LINE_PENDING_COOKIE,
  createLinePendingToken,
  linePendingCookieOptions,
} from '@/lib/line-pending';
import { createLineState, verifyLineState } from '@/lib/line-state';
import { publicBaseUrlOr } from '@/lib/public-url';
import { chargeRateLimit } from '@/lib/rate-limit';

/** The one landing every failure here shares: the front door, which can explain itself. */
const FAILURE_LANDING = { page: 'login', result: 'error' } as const;

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    /*
     * The base every landing redirect is built on: the deployment's public address when
     * configured, the request's own origin otherwise. The request origin behind the shop's
     * reverse proxy is `localhost:3000` — the customer would be sent home to a host their
     * browser cannot reach, the same failure that named this configuration.
     */
    const base = publicBaseUrlOr(request.url);
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');
    /*
     * LINE sends its own errors to this callback with the state beside them — including the
     * refusal a customer makes by pressing cancel, which is not a failure to retry.
     */
    const lineError = requestUrl.searchParams.get('error');

    /*
     * The one place a failure leaves by, so no branch can forget the log line or the
     * retry. The redirect is the customer's answer; the line in the log is the operator's,
     * and it is the only thing that can turn "it doesn't work on my phone" into a stage.
     */
    const refused = async (
      failure: LineArrivalFailure,
      context: { intent: LineIntent; retried: boolean; channelId: string },
    ): Promise<Response> => {
      console.warn(
        `[line] callback refused at ${failure}${
          lineError === null ? '' : ` (${lineError})`
        }${context.retried ? ' on the retry' : ''}`,
      );

      if (planLineRetry({ failure, lineError, retried: context.retried }) === 'fail') {
        return NextResponse.redirect(lineLandingUrl(base, FAILURE_LANDING));
      }

      /*
       * The second walk goes straight to LINE with auto login off, and with a state that
       * says it is the second walk — so this remedy cannot mint another one. The address is
       * `buildLineAuthorizeUrl`'s, the same one the sign-in page puts in its button and the
       * authorize route sends, because a retry that forgot `scope=openid` would fail for a
       * reason nobody had seen before.
       */
      const retryState = await createLineState(context.intent, { retried: true });
      return NextResponse.redirect(
        buildLineAuthorizeUrl({
          channelId: context.channelId,
          redirectUri: lineRedirectUri(base),
          state: retryState,
          disableAutoLogin: true,
        }),
      );
    };

    const channelId = readLineChannelId();
    if (!channelId || !state) {
      // Nothing to retry with: LINE has not answered yet, or this deployment has no channel
      // to ask at all. A second walk would be a second dead end.
      console.warn(
        `[line] callback refused at ${channelId === null ? 'no-channel' : 'no-state'}`,
      );
      return NextResponse.redirect(lineLandingUrl(base, FAILURE_LANDING));
    }

    /*
     * 1. The state we minted, still inside its five minutes — and which door minted it.
     *    One function, because a check written inline here is a check that can drift from
     *    the claims the mint side sets; `verifyLineState` pins the issuer, the audience and
     *    the purpose together, and a token of any other family is refused by it.
     */
    let intent: LineIntent;
    let retried: boolean;
    try {
      const arrival = await verifyLineState(state);
      intent = arrival.intent;
      retried = arrival.retried;
    } catch {
      // A callback with no state of ours is not a failed sign-in to retry: it is a request
      // somebody else started, and walking them to LINE would be doing them a favour.
      console.warn('[line] callback refused at state');
      return NextResponse.redirect(lineLandingUrl(base, FAILURE_LANDING));
    }

    /*
     * 2. Charged *after* the state checks out, and keyed by the address like the other
     *    session-less doors. The work behind this point is an outbound HTTPS request to
     *    LINE and, on the sign-in path, a minted session — which is why the door is limited
     *    at all, even though a state that verifies is one we minted ourselves.
     */
    await chargeRateLimit(request, 'line_callback');

    const retryable = { intent, retried, channelId };

    if (lineError !== null) {
      return refused('line-error', retryable);
    }

    if (!code) {
      return refused('incomplete', retryable);
    }

    const secret = process.env.LINE_LOGIN_CHANNEL_SECRET?.trim();
    if (!secret) {
      return refused('incomplete', retryable);
    }

    /*
     * 3. The code for the tokens — a server-to-server POST under the channel secret.
     *
     * The two ways this can fail are told apart here rather than collapsed, because only
     * one of them is worth a retry: an exchange that did not produce a token is what a
     * phone's failed auto login looks like from this side, while a token we could not
     * verify is this deployment's own configuration being wrong, and the same screens would
     * only mint the same refusal.
     */
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      // Must match the authorize request's redirect_uri character for character.
      redirect_uri: lineRedirectUri(base),
      client_id: channelId,
      client_secret: secret,
    });

    let identity: LineIdentity | null = null;
    let failure: 'code-exchange' | 'credential' | null = null;
    try {
      const tokenResponse = await fetch(readLineTokenUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const tokens = tokenResponse.ok
        ? ((await tokenResponse.json()) as { id_token?: string })
        : null;
      if (tokens?.id_token) {
        // The same verification the sign-in door performs.
        identity = await verifyLineIdToken(tokens.id_token);
      } else {
        failure = 'code-exchange';
      }
    } catch (error) {
      failure = error instanceof InvalidLineCredentialError ? 'credential' : 'code-exchange';
    }

    if (failure !== null) {
      return refused(failure, retryable);
    }
    if (identity === null) {
      // Unreachable — every path through the block above that ends without an identity sets
      // a failure beside it — and a redirect rather than a crash if that stops being true.
      return NextResponse.redirect(lineLandingUrl(base, FAILURE_LANDING));
    }

    // 4. Which door, and who (if anyone) holds this LINE account. The decision is pure and
    //    tested; this route is the adapter that carries it out.
    const session = await getSessionUser();
    const customer = await findCustomerByLineSubject(identity.subject);
    const outcome = planLineArrival({ intent, session, customer });

    switch (outcome.kind) {
      case 'bind': {
        if (session === null) {
          // Unreachable — `planLineArrival` refuses a binding without a member session —
          // and a redirect rather than a crash if it ever stops being one.
          return NextResponse.redirect(lineLandingUrl(base, { page: 'login', result: 'session' }));
        }
        try {
          await bindSignedInCustomer({ userId: session.id, subject: identity.subject });
        } catch (error) {
          /*
           * A LINE account another row already holds is the one refusal a customer can act
           * on ("ถ้าเป็นของคุณ โปรดยืนยันที่หน้าบัญชี"), so it gets its own word on the
           * account page. Everything else — a row that vanished mid-flow, a database that
           * said no — is the same "try again" as every other failure.
           *
           * This used to escape the handler and reach the browser as a 409 JSON body, on a
           * page a customer had arrived at by consenting with LINE: a wall of JSON where
           * the card should have been.
           */
          const result =
            error instanceof ConflictError && error.code === 'LINE_SUBJECT_TAKEN' ? 'taken' : 'error';
          return NextResponse.redirect(lineLandingUrl(base, { page: 'account', result }));
        }
        return NextResponse.redirect(lineLandingUrl(base, lineLandingFor(outcome)));
      }

      case 'sign-in': {
        if (customer === null) {
          return NextResponse.redirect(lineLandingUrl(base, FAILURE_LANDING));
        }
        await startSession({
          id: customer.id,
          role: 'member',
          fullName: customer.fullName,
          phone: customer.phone,
        });
        return NextResponse.redirect(`${base}${outcome.redirectTo}`);
      }

      case 'needs-phone': {
        /*
         * The proof is real and it belongs to *this* browser — so it goes back to it, in a
         * cookie no script can read and that expires in ten minutes. The phone step then
         * consumes an OTP against a number before anything is attached, which is the order
         * ADR 0030 §1 insists on: prove the number, then decide, then write.
         */
        const handoff = await createLinePendingToken({
          subject: identity.subject,
          displayName: identity.displayName,
          email: identity.email,
        });
        const response = NextResponse.redirect(lineLandingUrl(base, lineLandingFor(outcome)));
        response.cookies.set(
          LINE_PENDING_COOKIE,
          handoff,
          linePendingCookieOptions(process.env.NODE_ENV === 'production'),
        );
        return response;
      }

      case 'refused': {
        return NextResponse.redirect(lineLandingUrl(base, lineLandingFor(outcome)));
      }
    }
  });
}
