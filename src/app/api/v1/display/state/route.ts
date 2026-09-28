/**
 * What a customer screen should already be showing.
 *
 * The socket carries facts as they happen. This carries the facts that were
 * already true when the screen arrived — the shop's name, what it sells most of,
 * and which pre-orders are waiting. A display is plugged in, reloaded and
 * reconnected at arbitrary times, and none of those moments produce an event.
 *
 * Authenticated with the device token rather than a session, because the screen
 * has no account: the same `verifyDisplayToken` the socket handshake uses, so
 * revoking a screen takes effect here too.
 *
 * Deliberately not the cart. A bill is only meaningful while it is being rung up,
 * and replaying a stale one to a screen that has just come online would show a
 * customer a total nobody is charging them. The next change to the bill sends a
 * full snapshot anyway (see `display-view.ts`).
 */
import { withApi } from '@/lib/api';
import { buildDisplayState } from '@/lib/display-broadcast';
import { requireDisplayDevice } from '@/lib/display-devices';

export async function GET(request: Request): Promise<Response> {
  return withApi(async () => {
    await requireDisplayDevice(request);
    return buildDisplayState();
  });
}
