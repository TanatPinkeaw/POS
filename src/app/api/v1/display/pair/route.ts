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
import { chargeRateLimit } from '@/lib/rate-limit';
import { displayPairSchema } from '@/lib/schemas';

export async function POST(request: Request): Promise<Response> {
  return withApi(async () => {
    /*
     * Six digits is a million possibilities and the code dies minutes after it is
     * minted, so this is not the guessable door the login route is. What it is, is
     * a door that answers a wrong code for free — and a display hanging on a wall
     * in a shop is a machine somebody can sit next to and walk a code space from.
     */
    await chargeRateLimit(request, 'pair_attempt');

    const body = await readJson(request, displayPairSchema);
    return redeemPairingCode(body.code);
  });
}
