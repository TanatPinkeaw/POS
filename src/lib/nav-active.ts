/**
 * Which nav item a path is on.
 *
 * The most specific match wins, and that rule is the whole reason this is a function
 * rather than a `startsWith` at the call site. The naive test — "does the path start
 * with my href" — marks `/pos` current while somebody is standing on
 * `/pos/preorders`, so the till and the pre-order board are both lit, and both
 * claim `aria-current="page"`. One of them is a link to a different screen, and a
 * screen reader announces two current pages.
 *
 * Nesting is normal here (`/pos` → `/pos/preorders`, `/admin/dashboard` under
 * `/admin`), so the fix is not to stop matching ancestors but to pick the deepest
 * one, which is the item a person would say they are on.
 *
 * `null` when the path is on none of them — a detail route the nav does not list, or
 * a not-found page rendered inside the shell — so a caller leaves every item
 * unhighlighted rather than guessing at the first one.
 */
export function activeNavHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;

  for (const href of hrefs) {
    // A whole path segment, not a string prefix: `/pos` must not match `/pos-other`.
    if (pathname !== href && !pathname.startsWith(`${href}/`)) {
      continue;
    }
    if (best === null || href.length > best.length) {
      best = href;
    }
  }

  return best;
}
