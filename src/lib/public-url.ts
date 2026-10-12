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
 *
 * **A route handler cannot derive it, on any deployment** — which is a correction to what
 * this file used to say. The fallback below was described as "works on a direct
 * deployment"; measured on this checkout's own custom server, `request.url`'s origin in a
 * route handler is always `http://localhost:<port>`, whatever `Host` the browser asked for
 * (a request carrying `Host: example.test` is answered with a landing on `localhost`).
 * `localhost` is the *customer's* own machine, so an unconfigured deployment sends them to
 * a page that is not there — the same failure the proxy case produces, by a different
 * route. **`PUBLIC_BASE_URL` is therefore required, not merely recommended behind a
 * proxy**, and `.env.example` says so. The fallback stays because a *screen* derives a
 * real address from its headers (`publicBaseUrlForHeaders` below) and some callers have no
 * configuration to read; it is a last resort, not a supported deployment.
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

/**
 * The base to build an external URL from, falling back to the request's own origin.
 *
 * The fallback is `localhost:<port>` in practice rather than the host the customer asked
 * for — see the module comment. It is kept for callers that have no configured value and
 * can live with a partly-broken link (a link in an email body, say), never as a way to
 * serve a customer behind a deployment nobody configured.
 */
export function publicBaseUrlOr(
  requestUrl: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return readPublicBaseUrl(env) ?? new URL(requestUrl).origin;
}

/**
 * The same address, for a *screen* rather than a route (ADR 0030 §1, amended).
 *
 * A server component has no `request.url` to read an origin from: it has the headers the
 * request arrived with. The precedence is deliberately `publicBaseUrlOr`'s — configuration
 * first, because behind the shop's tunnel the Host the process sees is `localhost:3000`, and
 * a customer sent there cannot reach the page — and the fallback is the host the *browser*
 * asked for, which is the same answer a route handler derives from `request.url`. The two
 * halves of the LINE flow must name their callback address identically (LINE compares
 * `redirect_uri` character for character at the token exchange), so the sign-in page mints
 * its own address with this rather than deriving one of its own.
 *
 * Null only when the request carries no Host at all — which the framework cannot route to a
 * page in the first place, and which the caller reads as a door the shop has not configured.
 */
export function publicBaseUrlForHeaders(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = readPublicBaseUrl(env);
  if (configured) {
    return configured;
  }

  // A chain of proxies leaves comma-separated lists in both of these; the first value is
  // the client's own hop, which is the address the customer's browser used.
  const host = firstHeaderValue(headers.get('x-forwarded-host') ?? headers.get('host'));
  if (host === null) {
    return null;
  }
  return `${firstHeaderValue(headers.get('x-forwarded-proto')) ?? 'http'}://${host}`;
}

/** The client's own value out of a header a proxy may have appended its own hops to. */
function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim();
  return first === undefined || first.length === 0 ? null : first;
}
