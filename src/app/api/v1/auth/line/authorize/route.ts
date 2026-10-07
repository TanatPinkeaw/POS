/**
 * `GET /api/v1/auth/line/authorize` — start the LINE Login browser flow (ADR 0030 §1,
 * amended).
 *
 * One flow, two doors, and which one a press is has to be decided *here* and sealed into
 * the state — the front door signs a customer in, the account page binds a LINE account
 * to the row the browser is already signed in as. The first version of this route had one
 * meaning (bind) and both doors used it, so the button on `/login` walked an anonymous
 * visitor through LINE's consent screen and delivered them to `/shop/account`, which
 * needs the member session they had just failed to obtain: consent, then straight back to
 * the login page. The decision now lives in `line-door.ts` and travels in the signature,
 * where a customer cannot edit it.
 *
 * The `redirect_uri` is the deployment's public address rather than the request's own,
 * which is not a detail: behind the shop's reverse proxy the server sees
 * `localhost:3000`, and a `redirect_uri` built from that is the literal failure a customer
 * met once already — LINE refused to send them anywhere. `PUBLIC_BASE_URL` is where their
 * browser actually lives.
 */
import { NextResponse } from 'next/server';

import { withApi } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { ValidationError } from '@/lib/errors';
import { lineIntentFor } from '@/lib/line-door';
import { readLineChannelId } from '@/lib/line-id-token';
import { createLineState } from '@/lib/line-state';
import { publicBaseUrlOr } from '@/lib/public-url';

/** Where LINE shows the customer their consent screen. */
const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize';

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
     * Which door this is. An explicit `?intent=sign-in` wins, and the fallback is the
     * session rather than anything the caller said — so a bare URL (a bookmark, a QR, a
     * link somebody pasted) signs a visitor in instead of looping them, and a shared
     * tablet's session cannot silently turn somebody else's sign-in press into a write.
     */
    const intent = lineIntentFor({
      requested: new URL(request.url).searchParams.get('intent'),
      hasSession: (await getSessionUser()) !== null,
    });

    const redirectUri = `${publicBaseUrlOr(request.url)}/api/v1/auth/line/callback`;
    const state = await createLineState(intent);

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
