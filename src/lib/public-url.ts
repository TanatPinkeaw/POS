/**
 * The deployment's own public address (ADR 0030).
 *
 * Two doors hand the customer to **LINE's** servers and take them back, and
 * both must name the address the *browser* can reach — not the one the Node
 * process sees. Behind a reverse proxy (the shop's tunnel on the HomeLab), the
 * Host the server receives is `localhost:3000`, and a callback URL built from
 * `request.url` literally registered itself as `localhost` at LINE: the exact
 * failure a customer met when the consent screen refused to send them home.
 *
 * So the address is configuration, not derivation: `PUBLIC_BASE_URL` states
 * where the shop's browser actually lands, and the two LINE doors use it.
 * Unset, the fallback derives from the request — which works on a direct
 * deployment and is wrong behind a proxy, which is why the `.env.example` line
 * for it says to set it on any deployment behind one.
 *
 * The value is trusted here the way `NOTIFY_WEBHOOK_URL` already is: both name
 * an external address the operator owns, and only the operator writes `.env`.
 */
export function readPublicBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const url = env.PUBLIC_BASE_URL?.trim();
  if (!url || url.length === 0) {
    return null;
  }
  // One trailing slash is a copy-paste accident, two are two accidents: strip
  // them all, so `${base}/path` is always joinable.
  return url.replace(/\/+$/, '');
}

/** The base to build an external URL from, falling back to the request's own. */
export function publicBaseUrlOr(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return readPublicBaseUrl(env) ?? new URL(requestUrl).origin;
}
