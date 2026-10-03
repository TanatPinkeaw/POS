/**
 * The guard that keeps every screen styled (ADR 0003 §5).
 *
 * Two kinds of test here, and the second is the one that matters. The samples
 * prove the detector fires on the shapes a real page has — React's `class`
 * attributes, a CSS module's hashed selectors, an `@import` at the top of a
 * generated sheet. The last block ties the route table to this repository's own
 * `src/app`, so a screen that is added, moved or deleted without being added to
 * the walk fails `npm test` rather than silently going unaudited. A walk that
 * quietly stops covering a screen is worse than no walk, because it looks green.
 */
import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ROUTE_WALK,
  auditPage,
  blankCssNoise,
  bodyClasses,
  classNames,
  definedClasses,
  inlineStyles,
  offSiteReferences,
  resolveHref,
  routePaths,
  stylesheetHrefs,
  type RouteSpec,
} from '@/lib/route-audit';

const ORIGIN = 'http://127.0.0.1:3211';
const ANY = ROUTE_WALK.find((entry) => entry.path === '/admin/dashboard') as RouteSpec;

/** Renders one route against a canned sheet, so the checks can be exercised. */
function audit(html: string, css: string, route: RouteSpec = ANY) {
  return auditPage({
    route,
    html,
    sheets: [{ href: '/_next/static/css/app.css', css }],
    baseOrigin: ORIGIN,
  });
}

describe('reading a rendered page', () => {
  it('collects every class token, including several on one element', () => {
    expect(classNames('<div class="ln-card dark"><span class="ln-num">฿107.00</span></div>')).toEqual(
      ['ln-card', 'dark', 'ln-num'],
    );
  });

  it('reads the theme class off the body tag', () => {
    expect(bodyClasses('<body class="dark ln-body">')).toEqual(['dark', 'ln-body']);
    expect(bodyClasses('<body class="ln-body">')).toEqual(['ln-body']);
    expect(bodyClasses('<body>')).toEqual([]);
  });

  it('takes both the stylesheet links and the preloads Next emits', () => {
    const html = `
      <link rel="preload" as="style" href="/_next/static/css/a.css"/>
      <link rel="stylesheet" href="/_next/static/css/b.css"/>
      <link rel="preload" as="script" href="/_next/static/chunks/x.js"/>
      <link rel="icon" href="/favicon.ico"/>
    `;

    // The error boundary's sheet is preloaded on every route (ADR 0003), and a
    // preload that is not counted would make a real sheet look missing.
    expect(stylesheetHrefs(html)).toEqual([
      '/_next/static/css/a.css',
      '/_next/static/css/b.css',
    ]);
  });

  it('reads inline style blocks too, because Next inlines font CSS', () => {
    expect(inlineStyles('<style>.a{color:red}</style><style>.b{}</style>')).toEqual([
      '.a{color:red}',
      '.b{}',
    ]);
  });
});

describe('reading selectors out of a stylesheet', () => {
  it('ignores property values that look like selectors', () => {
    const css = `
      .ln-logo { background: url(/brand/logo.svg); line-height: 1.65; }
      .ln-x { background: url("/brand/other.png") no-repeat; }
    `;

    const defined = definedClasses(css);

    // `svg`, `png` and `65` are the false positives this exists to prevent: a
    // class that appears defined because a path or a measurement contains a dot
    // would let a genuinely undefined class through.
    expect(defined.has('ln-logo')).toBe(true);
    expect(defined.has('ln-x')).toBe(true);
    expect(defined.has('svg')).toBe(false);
    expect(defined.has('png')).toBe(false);
    expect(defined.has('65')).toBe(false);
  });

  it('finds a class declared as part of a compound selector', () => {
    // The dark theme is written `body.dark` rather than `.dark`, so a scan that
    // only recognised a leading dot would call the whole theme undefined.
    expect([...definedClasses('body.dark { --ln-bg: #000; }')]).toEqual(['dark']);
  });

  it('ignores classes mentioned inside comments', () => {
    expect(definedClasses('/* .ln-gone { } */ .ln-here { }')).toEqual(new Set(['ln-here']));
  });

  it('blanks noise without moving anything else', () => {
    const css = '.ln-a { background: url(/x.svg); color: red; } /* .ln-b */';

    const blanked = blankCssNoise(css);

    expect(blanked).toHaveLength(css.length);
    expect(blanked).not.toContain('x.svg');
    expect(blanked).not.toContain('ln-b');
    expect(blanked).toContain('.ln-a');
  });
});

describe('references that leave the deployment', () => {
  it('catches an off-site script or stylesheet in the markup', () => {
    const found = offSiteReferences(
      {
        html: `
          <link rel="stylesheet" href="https://cdn.example.com/app.css"/>
          <script src="//fonts.googleapis.com/x.js"></script>
          <link rel="stylesheet" href="/_next/static/css/app.css"/>
        `,
      },
      ORIGIN,
    );

    expect(found.map((entry) => entry.url)).toEqual([
      'https://cdn.example.com/app.css',
      '//fonts.googleapis.com/x.js',
    ]);
  });

  it('lets a product photo come from wherever the shop keeps its pictures', () => {
    // ADR 0014. The photo is the shop's own data — a Nextcloud folder, its
    // hosting, its drive — and a picture that fails to load costs one tile its
    // placeholder. The script and the stylesheet are this deployment's own, and a
    // failure there costs the whole screen.
    const found = offSiteReferences(
      {
        html: `
          <img src="https://drive.example.stream/s/abc123/preview" alt=""/>
          <link rel="stylesheet" href="https://cdn.example.com/app.css"/>
        `,
      },
      ORIGIN,
    );

    expect(found.map((entry) => entry.url)).toEqual(['https://cdn.example.com/app.css']);
  });

  it('catches the @import that made the self-hosted fonts a lie', () => {
    // This is not a hypothetical: the vendored sheet carried its own Google
    // Fonts import, so the receipt phoned Google before it printed, and nothing
    // in the source tree said so because the sheet was generated.
    const found = offSiteReferences(
      { css: '@import url("https://fonts.googleapis.com/css2?family=Inter");' },
      ORIGIN,
    );

    expect(found).toEqual([
      { url: 'https://fonts.googleapis.com/css2?family=Inter', where: 'css' },
    ]);
  });

  it('counts a same-origin font as ours', () => {
    expect(
      offSiteReferences(
        { css: '@font-face { src: url(/fonts/inter.woff2) format("woff2"); }' },
        ORIGIN,
      ),
    ).toEqual([]);
  });

  it('resolves a relative stylesheet against the page, and refuses a remote one', () => {
    expect(resolveHref('/_next/static/css/a.css', '/admin/products', ORIGIN)).toBe(
      `${ORIGIN}/_next/static/css/a.css`,
    );
    expect(resolveHref('./a.css', '/admin/products', ORIGIN)).toBe(`${ORIGIN}/admin/a.css`);
    expect(resolveHref('https://cdn.example.com/a.css', '/admin/products', ORIGIN)).toBeNull();
  });
});

describe('auditing one page', () => {
  it('passes a page whose every class is defined', () => {
    const css = `
      .ln-card { color: red; }
      body.dark { color: white; }
      .ln-num { font-variant-numeric: tabular-nums; }
    `;

    expect(audit('<body class="dark"><div class="ln-card ln-num">฿107.00</div></body>', css)).toEqual(
      [],
    );
  });

  it('reports the class nothing defines', () => {
    const findings = audit('<div class="ln-card ln-typo">x</div>', '.ln-card { color: red; }');

    expect(findings).toEqual([
      { route: '/admin/dashboard', rule: 'undefined-class', text: 'ln-typo' },
    ]);
  });

  it('reports a page that loads no CSS at all', () => {
    const findings = auditPage({
      route: ANY,
      html: '<body><div class="ln-card">x</div></body>',
      sheets: [],
      baseOrigin: ORIGIN,
    });

    expect(findings.map((finding) => finding.rule)).toContain('no-stylesheet');
  });

  it('reports an off-site reference once, however many times it appears', () => {
    const html =
      '<link rel="stylesheet" href="https://cdn.example.com/a.css"/>' +
      '<link rel="stylesheet" href="https://cdn.example.com/a.css"/>';

    expect(audit(html, '.ln-card{}').length).toBe(1);
  });

  it('reads classes out of an inline style block as well as a linked sheet', () => {
    expect(audit('<div class="ln-inline">x</div>', '/* empty */').length).toBe(1);

    const html = '<style>.ln-inline{color:red}</style><div class="ln-inline">x</div>';
    expect(audit(html, '/* empty */')).toEqual([]);
  });
});

describe('the route walk', () => {
  it('covers twenty-three distinct paths across the four areas', () => {
    expect(routePaths()).toHaveLength(23);
    expect(new Set(ROUTE_WALK.map((entry) => entry.area))).toEqual(
      new Set(['public', 'admin', 'pos', 'shop']),
    );
  });

  it('states where each request must land', () => {
    for (const entry of ROUTE_WALK) {
      expect(entry.landsOn.startsWith('/')).toBe(true);

      // A screen that renders in place says so; anything else is a redirect, and
      // a redirect to itself would be a check that never arrives anywhere.
      if (entry.landsOn !== entry.path) {
        expect(entry.landsOn).not.toBe(entry.path);
      }
    }
  });

  it('sends each role to the home its own area claims', () => {
    const frontDoor = ROUTE_WALK.filter((entry) => entry.path === '/' && entry.session !== 'none');

    expect(frontDoor.map((entry) => [entry.session, entry.landsOn])).toEqual([
      ['admin', '/admin/dashboard'],
      ['cashier', '/pos'],
      ['member', '/shop/products'],
    ]);
  });

  it('agrees with the files on disk, in both directions', () => {
    const onDisk = [...appRoutePaths()].sort();

    // Direction one: every screen this app serves is somewhere in the walk. A
    // new screen that skips the table fails here.
    for (const path of onDisk) {
      expect(routePaths(), `no walk entry for ${path}`).toContain(path);
    }

    // Direction two: nothing in the walk names a screen that does not exist —
    // which is what would otherwise turn a renamed route into a check of
    // whatever the proxy redirects to.
    for (const path of routePaths()) {
      expect(onDisk, `walk entry ${path} has no page`).toContain(path);
    }
  });
});

/**
 * Every page path this app serves, read off `src/app`.
 *
 * A route group (`(admin)`, `(pos)`) is a folder name that does not appear in a
 * URL, so segments wrapped in parentheses are dropped. This is the same rule the
 * App Router applies, written down once, here, where a mismatch is a test
 * failure rather than a 404 somebody notices in production.
 */
function appRoutePaths(): Set<string> {
  const paths = new Set<string>();

  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const next = /^\(.+\)$/.test(entry.name) ? segments : [...segments, entry.name];
        walk(join(dir, entry.name), next);
        continue;
      }
      if (entry.name === 'page.tsx') {
        paths.add(segments.length === 0 ? '/' : `/${segments.join('/')}`);
      }
    }
  };

  walk(join('src', 'app'), []);
  // A separator sneaking in would make the comparison above pass on Windows and
  // fail in CI, which is the one place a guard must not be platform-specific.
  return new Set([...paths].map((path) => path.split(sep).join('/')));
}
