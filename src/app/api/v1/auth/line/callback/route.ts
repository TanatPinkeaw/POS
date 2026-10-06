/**
 * `GET /api/v1/auth/line/callback` — LINE sends the customer back here
 * (ADR 0030 §1).
 *
 * The browser half of the account-page link flow. The customer returns from
 * LINE's consent screen with `?code=…&state=…`; this route verifies the state it
 * minted five minutes ago, exchanges the code for an **id token** (a POST from
 * this server to LINE's token endpoint, over the channel secret — the code is
 * never trusted by itself), verifies that token the same way the sign-in door
 * does, and binds it to the customer the session names.
 *
 * Two deliberate shapes:
 *
 *   * **A signed-in customer is required.** This flow binds a LINE account to a
 *     row the browser is already authenticated as — the takeover argument is the
 *     session's, not an OTP's, exactly as `bindSignedInCustomer` records. A first
 *     sign-in with no session goes through `/api/v1/auth/line` + `link` instead,
 *     where the phone is proved; this route refuses them rather than inventing a
 *     third way to become a customer.
 *   * **The answer is a redirect, not a JSON.** The customer is in a browser that
 *     followed LINE's redirects; a JSON body would be a white page. Back to
 *     `/shop/account?line=bound` (or `?line=error`), where the page reads the
 *     query and shows the card in its new state.
 */
import { jwtVerify } from 'jose';
import { NextResponse } from 'next/server';

import { withApi } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { readLineChannelId, verifyLineIdToken } from '@/lib/line-id-token';
import { bindSignedInCustomer } from '@/lib/line-identity';
import { publicBaseUrlOr } from '@/lib/public-url';
import { authSecretKey } from '@/lib/session-token';

/** Where LINE exchanges a code for tokens. */
const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';

/** The account page the customer lands back on, with a one-word result. */
const ACCOUNT_PAGE = '/shop/account';

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    /*
     * The base every landing redirect is built on: the deployment's public
     * address when configured, the request's own origin otherwise. The request
     * origin behind the shop's reverse proxy is `localhost:3000` — the customer
     * would be sent home to a host their browser cannot reach, the same failure
     * that named this configuration.
     */
    const base = publicBaseUrlOr(request.url);
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get('code');
    const state = requestUrl.searchParams.get('state');
    const channelId = readLineChannelId();

    if (!channelId || !code || !state) {
      return NextResponse.redirect(`${base}${ACCOUNT_PAGE}?line=error`);
    }

    try {
      // 1. The state we minted, still inside its five minutes.
      await jwtVerify(state, authSecretKey());
    } catch {
      return NextResponse.redirect(`${base}${ACCOUNT_PAGE}?line=error`);
    }

    // 2. The code for the tokens — a server-to-server POST under the channel secret.
    const secret = process.env.LINE_LOGIN_CHANNEL_SECRET?.trim();
    if (!secret) {
      return NextResponse.redirect(`${base}${ACCOUNT_PAGE}?line=error`);
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      // Must match the authorize request's redirect_uri character for character.
      redirect_uri: `${base}/api/v1/auth/line/callback`,
      client_id: channelId,
      client_secret: secret,
    });

    try {
      const tokenResponse = await fetch(LINE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenResponse.ok) {
        return NextResponse.redirect(`${base}${ACCOUNT_PAGE}?line=error`);
      }
      const tokens = (await tokenResponse.json()) as { id_token?: string };
      if (!tokens.id_token) {
        return NextResponse.redirect(`${base}${ACCOUNT_PAGE}?line=error`);
      }

      // 3. The same verification the sign-in door performs.
      const identity = await verifyLineIdToken(tokens.id_token);

      // 4. Bind to the session's row — the session is the takeover argument.
      const session = await getSessionUser();
      if (!session || session.role !== 'member') {
        return NextResponse.redirect(`${base}${ACCOUNT_PAGE}?line=session`);
      }

      await bindSignedInCustomer({ userId: session.id, subject: identity.subject });

      return NextResponse.redirect(`${base}${ACCOUNT_PAGE}?line=bound`);
    } catch {
      return NextResponse.redirect(`${base}${ACCOUNT_PAGE}?line=error`);
    }
  });
}
