/**
 * Where a press of a LINE door starts (ADR 0030 §1, amended).
 *
 * This module exists because of *when* the address is built. It used to be built when the
 * button was pressed: the button pointed at a route of ours, and that route answered with a
 * redirect to LINE. LINE's own guide to the phone failure this feature already handles names
 * two ways the app handoff does not happen — a **JavaScript** redirect to the authorization
 * URL, and a customer typing the URL in — and gives one workaround: let the customer **tap a
 * button that goes to the authorization URL**. A press that lands on a route of ours first
 * reaches LINE by redirect, which is the shape that guide is steering away from; a press
 * whose `href` *is* LINE's address reaches it by tap.
 *
 * So the address is minted while the page is painted and travels inside the link. The
 * consequence is a debt this module's callers must pay: the state's life starts then, not at
 * the press, which is why `LINE_STATE_TTL_SECONDS` is no longer one walk (see its comment).
 * The other is that the page must be rendered per request — a cached copy of it would hand
 * every customer the same state, or a state that expired with the cache.
 *
 * The address itself is still assembled by `buildLineAuthorizeUrl`, beside the retry the
 * callback sends: one assembly, three callers, and the retry cannot drift from the entrance.
 */
import { type LineIntent, buildLineAuthorizeUrl, lineRedirectUri } from './line-door';
import { createLineState } from './line-state';

/**
 * The authorization address a *first* press goes to, with a state minted for it.
 *
 * `retried` is never set here. The one retry a failure can earn is minted by the callback
 * that failed, which is what keeps the ceiling unforgeable — a page anyone can load must not
 * be able to hand out a second walk.
 */
export async function lineStartHref(input: {
  intent: LineIntent;
  /** The deployment's own public address — the page's, from `publicBaseUrlForHeaders`. */
  base: string;
  channelId: string;
}): Promise<string> {
  return buildLineAuthorizeUrl({
    channelId: input.channelId,
    redirectUri: lineRedirectUri(input.base),
    state: await createLineState(input.intent),
    // Off for a first press: the app handoff is the smoother path when it works, and LINE
    // recommends switching auto login off as the recovery rather than as the entrance.
    disableAutoLogin: false,
  });
}
