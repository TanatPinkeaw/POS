/**
 * Which image links a screen is allowed to load.
 *
 * The catalogue's photos do not live in this deployment. A shop keeps its pictures
 * where its pictures already are — for the reference installation, a Nextcloud folder
 * in the same homelab — and pastes the link into the product form, which is why
 * `products.image_url` is a link rather than a path (ADR 0014). So a screen is being
 * asked to fetch from an origin that is not this one, and that has to be a decision
 * rather than an accident: this function is the only place that decides.
 *
 * It is a **positive list**, not a sanitiser. A denylist of `javascript:` and `data:`
 * goes stale the first time a scheme nobody here has heard of turns up, whereas the
 * two forms a shop actually uses are both knowable:
 *
 *   * `https://…` and `http://…` — the shop's own host, or one it chooses.
 *   * a root-relative path, `/products/coffee.jpg` — something this deployment
 *     serves, which needs no scheme at all.
 *
 * Everything else renders as the placeholder instead, and the refusals are worth
 * naming because each one is a real mistake rather than a hypothetical:
 *
 *   * `data:` — an image inline in a column would make every catalogue page
 *     megabytes long, which is the opposite of the paging `product-query.ts` exists
 *     for.
 *   * `javascript:` and `file:` — never a picture.
 *   * a bare host, `example.com/x.jpg` — a browser resolves that *relative to the
 *     current page*, so it fetches a 404 from the wrong place and looks like a
 *     broken image rather than a bad link.
 *   * protocol-relative, `//host/x.jpg` — the browser would honour it, and it is
 *     refused anyway: it is the one form whose destination is not visible in the link
 *     an operator pasted, and no shop needs it.
 */
export function renderableImageUrl(value: string | null | undefined): string | null {
  const candidate = (value ?? '').trim();
  if (candidate === '') {
    return null;
  }

  if (candidate.startsWith('/')) {
    return candidate.startsWith('//') ? null : candidate;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
