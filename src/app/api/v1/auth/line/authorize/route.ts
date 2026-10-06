/**
 * `GET /api/v1/auth/line/authorize` — start the LINE Login browser flow
 * (ADR 0030 §1).
 *
 * The id-token door works in one setting: LINE's own authorization screen in
 * their in-app browser. This route exists for the second one — a customer on
 * `/shop/account`, in any browser, pressing "ผูกบัญชี LINE" — and it is a plain
 * redirect to LINE's authorization endpoint with a `state` value this deployment
 * minted.
 *
 * The state is the CSRF control, and it is a signed JWT rather than a session
 * row: five minutes, no storage, and `jose` (already a dependency) verifies it on
 * the way back (`/api/v1/auth/line/callback`) before the code is exchanged.
 * A state that survives a restart is the difference between this working behind
 * the shop's own tunnel and working only in tests.
 */
import { SignJWT } from 'jose';
import { NextResponse } from 'next/server';

import { withApi } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { ValidationError } from '@/lib/errors';
import { readLineChannelId } from '@/lib/line-id-token';
import { publicBaseUrlOr } from '@/lib/public-url';
import { authSecretKey } from '@/lib/session-token';

/** Where LINE shows the customer their consent screen. */
const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize';

/** How long the minted state may live — one walk through LINE's screens. */
const STATE_TTL_SECONDS = 300;

/**
 * The state is signed under the same key as the session token, exported for
 * exactly this: it is already on the box, already rotated by whoever rotates that
 * one, and a state is a CSRF token rather than a credential — the worst a leaked
 * signing key buys here is a forgery that must still complete a real LINE
 * exchange. Different claim (`purpose`) and a five-minute life, so the two token
 * kinds cannot be confused for each other.
 */
const stateKey = authSecretKey;

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    const channelId = readLineChannelId();
    if (!channelId) {
      // Thai, per rule 6: the screen reading this is the customer's own. The
      // English env-var name is what the operator greps for, so it stays quoted.
      throw new ValidationError(
        'ร้านยังไม่ได้ตั้งค่าการเชื่อมต่อ LINE — ผู้ดูแลต้องตั้งค่า LINE_LOGIN_CHANNEL_ID ก่อน',
      );
    }

    /*
     * Where LINE sends the customer back — the deployment's public address, not
     * the origin the request arrived with. Behind the shop's reverse proxy the
     * server sees `localhost:3000`, and a redirect_uri built from that is the
     * literal bug a customer met: LINE refused to send them anywhere in the
     * first place. `PUBLIC_BASE_URL` is where their browser actually lives.
     */
    const redirectUri = `${publicBaseUrlOr(request.url)}/api/v1/auth/line/callback`;

    const state = await new SignJWT({ purpose: 'line-link' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${STATE_TTL_SECONDS}s`)
      .sign(stateKey());

    const authorizeUrl = new URL(LINE_AUTHORIZE_URL);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', channelId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('state', state);
    // The id token is what this system verifies; the profile names the customer.
    authorizeUrl.searchParams.set('scope', 'openid profile email');
    // `code` keeps the customer in the browser flow rather than LINE's app.
    authorizeUrl.searchParams.set('prompt', 'consent');

    return NextResponse.redirect(authorizeUrl.toString());
  });
}
