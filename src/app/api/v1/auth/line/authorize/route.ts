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
 *
 * The address itself is assembled by `buildLineAuthorizeUrl` rather than here, because the
 * callback sends a customer to the same address — one parameter different — when a phone's
 * auto login failed. Two copies of this query is how a retry loses `scope=openid` and
 * becomes a second failure with a new cause.
 */
import { NextResponse } from 'next/server';

import { withApi } from '@/lib/api';
import { getSessionUser } from '@/lib/auth';
import { ValidationError } from '@/lib/errors';
import { buildLineAuthorizeUrl, lineIntentFor } from '@/lib/line-door';
import { readLineChannelId } from '@/lib/line-id-token';
import { createLineState } from '@/lib/line-state';
import { publicBaseUrlOr } from '@/lib/public-url';

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
    // Never `retried`: a press from the shop's own screen is a first attempt, and the
    // one retry a failure can earn is minted by the callback that failed.
    const state = await createLineState(intent);

    return NextResponse.redirect(
      buildLineAuthorizeUrl({ channelId, redirectUri, state, disableAutoLogin: false }),
    );
  });
}
