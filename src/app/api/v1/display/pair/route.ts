/**
 * Redeeming a pairing code for a device token.
 *
 * The one endpoint in this application reachable without a session, and it has to
 * be: the screen being paired is the thing that has no session. What keeps that
 * safe is that the request must carry a six-digit code an admin generated minutes
 * ago and is looking at — the code *is* the authentication, and it is spent on
 * first use, so a second request with the same code finds nothing to redeem.
 *
 * The token comes back exactly once. Nothing can look it up afterwards, because
 * only its hash is stored.
 */
import { readJson, withApi } from '@/lib/api';
import { redeemPairingCode } from '@/lib/display-devices';
import { displayPairSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    const body = await readJson(request, displayPairSchema);
    return redeemPairingCode(body.code);
  });
}
