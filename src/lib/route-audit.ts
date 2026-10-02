/**
 * The guard that keeps every screen styled — the pure half of `npm run route:audit`.
 *
 * The vendored theme is gone (ADR 0003), and `ui:audit` proves no Bootstrap class
 * survives in the source. What it cannot prove is the thing a renter actually
 * experiences: that the CSS a page loads **defines every class that page
 * renders**. Those are different failures. A CSS module that is never imported
 * compiles, type-checks, passes every unit test, and ships an unstyled screen —
 * and that is not hypothetical here: the theme deletion turned out to have left
 * the "fonts are self-hosted" fix inert for weeks, because the vendored
 * stylesheet carried its own Google Fonts `@import` and nothing looked at the
 * CSS that was actually served.
 *
 * So the rule is stated as one sentence: *every class in the HTML of a route is
 * defined by a stylesheet that route loads, and no code, stylesheet or font
 * references an origin other than this one.* A product photo is the exception, and
 * deliberately so — see `offSiteReferences`. Three properties are worth more than
 * cleverness:
 *
 *   * **The route list is data.** Twenty paths across four areas, each with the
 *     session it needs and the path it must land on. That table is also the only
 *     place the areas are written down outside `roles.ts`, so a screen that is
 *     moved and forgotten shows up as a redirect to a page the audit did not
 *     intend to check — rather than as a silent pass.
 *   * **The detection is pure.** Parsing HTML, reading selectors out of CSS and
 *     deciding what is undefined are all functions of a string, so they are
 *     unit-tested against samples *and* against this repository's own markup.
 *     `scripts/route-audit.ts` is only the part that cannot be: building,
 *     serving, and fetching.
 *   * **Nothing is exempted by name.** Unlike `ui-audit`, there is no allow-list
 *     of tolerated classes. A class in the HTML that no loaded sheet defines is
 *     a finding, full stop — which is what makes this check able to fail on a
 *     screen nobody has written yet.
 */

/** Which area of the application a route belongs to. */
export type RouteArea = 'public' | 'admin' | 'pos' | 'shop';

/** Which cookie jar the walker uses for a route. */
export type RouteSession = 'none' | 'admin' | 'cashier' | 'member';

export interface RouteSpec {
  /** The path requested. */
  path: string;
  area: RouteArea;
  session: RouteSession;
  /**
   * The path the request must end on — the path itself for a screen that just
   * renders, and the redirect target for one that does not.
   *
   * This is what stops the audit from passing vacuously: most of these screens
   * redirect somewhere when they are handed no session (or the wrong one), so "it
   * answered 200" would otherwise mean "the login page is styled" once per route.
   * Pinning the landing path also makes the table a live assertion about `roles.ts`
   * and the proxy — a front door that sends a manager to the till fails here rather
   * than passing as a styled page.
   */
  landsOn: string;
  label: string;
}

/**
 * Every screen this application serves, and how to reach it.
 *
 * Seventeen distinct paths; the root is listed four times because it is a
 * role-aware redirect and the interesting part of it is where each role lands.
 */
export const ROUTE_WALK: readonly RouteSpec[] = [
  { path: '/', area: 'public', session: 'none', landsOn: '/login', label: 'the front door, signed out' },
  { path: '/', area: 'public', session: 'admin', landsOn: '/admin/dashboard', label: 'the front door, as a manager' },
  { path: '/', area: 'public', session: 'cashier', landsOn: '/pos', label: 'the front door, as a cashier' },
  { path: '/', area: 'public', session: 'member', landsOn: '/shop/products', label: 'the front door, as a member' },
  { path: '/login', area: 'public', session: 'none', landsOn: '/login', label: 'the sign-in screen' },
  { path: '/setup', area: 'public', session: 'none', landsOn: '/login', label: 'the wizard, on a shop that is already set up' },
  { path: '/display', area: 'public', session: 'none', landsOn: '/display', label: 'the customer display' },
  { path: '/admin/dashboard', area: 'admin', session: 'admin', landsOn: '/admin/dashboard', label: 'the manager dashboard' },
  { path: '/admin/products', area: 'admin', session: 'admin', landsOn: '/admin/products', label: 'the catalogue' },
  { path: '/admin/members', area: 'admin', session: 'admin', landsOn: '/admin/members', label: 'the customers' },
  { path: '/admin/audit', area: 'admin', session: 'admin', landsOn: '/admin/audit', label: 'the audit trail' },
  { path: '/admin/reports', area: 'admin', session: 'admin', landsOn: '/admin/reports', label: 'the reports' },
  { path: '/admin/schedules', area: 'admin', session: 'admin', landsOn: '/admin/schedules', label: 'the roster' },
  { path: '/admin/settings', area: 'admin', session: 'admin', landsOn: '/admin/settings', label: 'the shop settings' },
  { path: '/admin/staff', area: 'admin', session: 'admin', landsOn: '/admin/staff', label: 'the staff screen' },
  { path: '/pos', area: 'pos', session: 'cashier', landsOn: '/pos', label: 'the register' },
  { path: '/pos/attendance', area: 'pos', session: 'cashier', landsOn: '/pos/attendance', label: 'attendance' },
  { path: '/pos/queue', area: 'pos', session: 'cashier', landsOn: '/pos/queue', label: 'the drink queue' },
  { path: '/pos/preorders', area: 'pos', session: 'cashier', landsOn: '/pos/preorders', label: 'the pre-order board' },
  { path: '/shop', area: 'public', session: 'none', landsOn: '/shop', label: 'the customer sign-in, both doors' },
  { path: '/shop/products', area: 'shop', session: 'member', landsOn: '/shop/products', label: 'the member catalogue' },
  { path: '/shop/orders', area: 'shop', session: 'member', landsOn: '/shop/orders', label: 'the member orders' },
  { path: '/shop/account', area: 'shop', session: 'member', landsOn: '/shop/account', label: 'the member account' },
];

/** The distinct paths in the walk — every page this application serves. */
export function routePaths(walk: readonly RouteSpec[] = ROUTE_WALK): string[] {
  return [...new Set(walk.map((entry) => entry.path))];
}

export type PageRule =
  | 'no-stylesheet'
  | 'undefined-class'
  | 'off-site-reference';

export interface PageFinding {
  /** The route as requested, so a finding names the screen a renter would open. */
  route: string;
  rule: PageRule;
  text: string;
}

export interface OffSiteReference {
  /** The URL or its host-bearing fragment, quoted in the report. */
  url: string;
  /** Where it was found, for a message that points at the cause. */
  where: 'html' | 'css';
}

/* -------------------------------------------------------------- html parsing */

/**
 * Class tokens out of every `class` attribute in a document.
 *
 * A regex rather than a parser, deliberately: the input is React's own output,
 * where an attribute value is a plain double-quoted list of names. Entity
 * decoding is unnecessary because a class name cannot contain `&` in any
 * stylesheet this project writes.
 */
export function classNames(html: string): string[] {
  const found: string[] = [];

  for (const match of html.matchAll(/\bclass="([^"]*)"/g)) {
    for (const token of (match[1] ?? '').split(/\s+/)) {
      if (token.length > 0) {
        found.push(token);
      }
    }
  }

  return found;
}

/** The classes on the `<body>` tag — where the theme cookie shows up. */
export function bodyClasses(html: string): string[] {
  const match = html.match(/<body[^>]*\bclass="([^"]*)"/);
  return match ? (match[1] ?? '').split(/\s+/).filter((token) => token.length > 0) : [];
}

/**
 * The stylesheets a page loads, in document order.
 *
 * Both `rel="stylesheet"` and `rel="preload" as="style"` are collected. The
 * second is real here: the root layout preloads the error boundary's sheet on
 * every route (documented in ADR 0003), and a stylesheet that is *loaded* counts
 * even when it is not yet *applied* — the question this check answers is whether
 * the CSS arrived, not whether the browser chose to use it yet.
 */
export function stylesheetHrefs(html: string): string[] {
  const found: string[] = [];

  for (const match of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = match[0];
    if (!/\brel="(stylesheet|preload)"/.test(tag)) {
      continue;
    }
    if (tag.includes('rel="preload"') && !tag.includes('as="style"')) {
      continue;
    }
    const href = tag.match(/\bhref="([^"]+)"/);
    if (href?.[1]) {
      found.push(href[1]);
    }
  }

  return found;
}

/** Every inline `<style>` block, which is CSS this check must also read. */
export function inlineStyles(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
    if (match[1]) {
      found.push(match[1]);
    }
  }
  return found;
}

/* --------------------------------------------------------------- css parsing */

/**
 * Blanks the parts of a stylesheet that are not selectors, preserving length.
 *
 * Without this the selector scan reads property values: `url(/brand/logo.svg)`
 * yields a class named `svg` and `line-height: 1.65` yields one named `65`, and
 * both would be reported as defined classes that nothing defines. Comments,
 * string literals and `url(…)` contents are therefore blanked rather than
 * removed — the same offset-preserving trick `ui-audit` uses, so a finding can
 * still be reported at a real position if this ever needs to.
 *
 * Deliberately *not* stripped: at-rule preludes. A class living inside
 * `@media print { … }` is a class the document defines, and the print rules are
 * where a receipt's layout lives.
 */
export function blankCssNoise(css: string): string {
  const out = css.split('');
  let i = 0;

  while (i < css.length) {
    const char = css[i];
    const next = css[i + 1];

    if (char === '/' && next === '*') {
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) {
        if (css[i] !== '\n') {
          out[i] = ' ';
        }
        i += 1;
      }
      // An unterminated comment must not extend the output: the offset
      // invariant this function promises is what keeps a report honest.
      if (i < out.length) {
        out[i] = ' ';
      }
      if (i + 1 < out.length) {
        out[i + 1] = ' ';
      }
      i += 2;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      out[i] = ' ';
      i += 1;
      while (i < css.length && css[i] !== quote) {
        if (css[i] !== '\n') {
          out[i] = ' ';
        }
        i += css[i] === '\\' ? 2 : 1;
      }
      if (i < out.length) {
        out[i] = ' ';
      }
      i += 1;
      continue;
    }

    // `url(` — the contents are a path, never a selector.
    if ((char === 'u' || char === 'U') && css.slice(i, i + 4).toLowerCase() === 'url(') {
      i += 4;
      let depth = 1;
      while (i < css.length && depth > 0) {
        if (css[i] === '(') {
          depth += 1;
        } else if (css[i] === ')') {
          depth -= 1;
        }
        if (css[i] !== '\n') {
          out[i] = ' ';
        }
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/**
 * Every class selector a stylesheet defines.
 *
 * `body.dark` defines `dark`, and that is the point — the theme class is
 * declared in `tokens.css` as a compound selector rather than on its own, so a
 * scan that only recognised `.foo` at the start of a selector would report the
 * dark theme as undefined on every page.
 *
 * The identifier must start with a letter, `_` or `-`, which is what keeps
 * decimals (`1.65em`, `0.5px`) out of the set without a special case.
 */
export function definedClasses(css: string): Set<string> {
  const defined = new Set<string>();

  for (const match of blankCssNoise(css).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    if (match[1]) {
      defined.add(match[1]);
    }
  }

  return defined;
}

/* ------------------------------------------------------- off-site references */

/**
 * Absolute references in a document, and whether they leave this deployment.
 *
 * This is the narrow, useful question: **code, stylesheets and fonts** may not come
 * from another origin. It is not a general "no third-party anything" rule — an `<a
 * href>` to somewhere on the internet is a link a shop may legitimately print — but a
 * `<script>`, a `<link>`, a `url()`, an `@import` or an `@font-face` that leaves the
 * host is a page that breaks when the shop's internet connection does, and a receipt
 * that phones Google before it prints.
 *
 * **An `<img>` is not in that list (ADR 0014).** A product photo is the shop's own
 * data, and the shop keeps its pictures where its pictures already are — a Nextcloud
 * folder in the same homelab, its hosting, its drive — which is another origin by
 * definition. Two reasons the trade is worth taking:
 *
 *   * A stylesheet that fails leaves an unstyled, unusable screen; a photo that fails
 *     leaves one tile with a placeholder in it, because `Thumb` draws the glyph on
 *     `onError`. The failure modes are not the same size.
 *   * The only alternative is keeping the bytes here, which needs an upload route, a
 *     place to put a file and a backup that covers it — a decision this repository has
 *     deliberately deferred (README, *Not built yet*), and one that would make photos
 *     a feature a shop waits for instead of a link it pastes.
 *
 * What is given up is stated where it belongs, in ADR 0014's gaps: a hardcoded
 * off-site image in a component now passes this check, and nothing else looks at it.
 */
export function offSiteReferences(
  input: { html?: string; css?: string },
  baseOrigin: string,
): OffSiteReference[] {
  const found: OffSiteReference[] = [];
  const html = input.html ?? '';
  const css = input.css ?? '';

  const record = (url: string, where: 'html' | 'css'): void => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(baseOrigin)) {
      found.push({ url, where });
    }
    // Protocol-relative URLs resolve to whatever scheme the page used, so they
    // are off-site whenever they name a host at all.
    if (/^\/\/[a-z0-9-]+\.[a-z]/i.test(url)) {
      found.push({ url, where });
    }
  };

  for (const match of html.matchAll(/<(?:script|link|iframe|source)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    if (match[1]) {
      record(match[1], 'html');
    }
  }
  for (const match of html.matchAll(/@import\s+(?:url\()?["']?([^"')]+)/g)) {
    if (match[1]) {
      record(match[1], 'html');
    }
  }
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    if (match[1]) {
      record(match[1], 'html');
    }
  }
  for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    if (match[1]) {
      record(match[1], 'css');
    }
  }
  for (const match of css.matchAll(/@import\s+(?:url\()?["']?([^"')]+)/g)) {
    if (match[1]) {
      record(match[1], 'css');
    }
  }

  const seen = new Set<string>();
  return found.filter((entry) => {
    const key = `${entry.where}:${entry.url}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/* ------------------------------------------------------------------ the check */

export interface LoadedStylesheet {
  href: string;
  css: string;
}

/**
 * Everything wrong with one rendered page.
 *
 * Findings rather than a boolean, because the report is the useful artefact: a
 * class name that nothing defines is actionable, "route /admin/reports failed"
 * is not.
 */
export function auditPage(input: {
  route: RouteSpec;
  html: string;
  sheets: LoadedStylesheet[];
  baseOrigin: string;
}): PageFinding[] {
  const { route, html, sheets, baseOrigin } = input;
  const findings: PageFinding[] = [];

  if (sheets.length === 0) {
    findings.push({
      route: route.path,
      rule: 'no-stylesheet',
      text: 'the page loaded no CSS at all',
    });
  }

  const allCss = [...sheets.map((sheet) => sheet.css), ...inlineStyles(html)].join('\n');
  const defined = definedClasses(allCss);

  for (const className of classNames(html)) {
    if (!defined.has(className)) {
      findings.push({
        route: route.path,
        rule: 'undefined-class',
        text: className,
      });
    }
  }

  for (const reference of offSiteReferences({ html: html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '') }, baseOrigin)) {
    findings.push({
      route: route.path,
      rule: 'off-site-reference',
      text: `${reference.url} (in the markup)`,
    });
  }

  /*
   * The stylesheets and any inline blocks are checked for off-site references
   * too — that is the exact shape of the bug that went unnoticed for weeks: an
   * `@import` at the top of a vendored sheet, invisible from the source tree
   * because the sheet itself was generated.
   */
  for (const reference of offSiteReferences({ css: allCss }, baseOrigin)) {
    findings.push({
      route: route.path,
      rule: 'off-site-reference',
      text: `${reference.url} (in CSS)`,
    });
  }

  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule}:${finding.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Resolves a stylesheet href against the page it was found on, or null when it
 * leaves this deployment or cannot be resolved at all.
 *
 * `new URL` rather than string concatenation, so a `./` or a `..` in a href is
 * normalised exactly the way a browser would and a fetch of the result is not
 * quietly asking for a path nobody serves.
 */
export function resolveHref(href: string, pagePath: string, baseOrigin: string): string | null {
  if (href.startsWith('//')) {
    return null;
  }
  if (/^https?:\/\//i.test(href)) {
    return href.startsWith(baseOrigin) ? href : null;
  }
  try {
    return new URL(href, `${baseOrigin}${pagePath}`).toString();
  } catch {
    return null;
  }
}
