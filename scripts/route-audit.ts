/**
 * `npm run route:audit` — every screen renders, and renders *styled*.
 *
 * `npm test` proves the detection in `src/lib/route-audit.ts` works on samples,
 * and that the walk covers every page file in `src/app`. This is the part that
 * cannot be proven from a string: build the app, serve the production build
 * against a schema that has just been set up the way a renter would set it up,
 * open all eighteen screens with the session each one needs, and check the CSS
 * that came back actually defines the markup.
 *
 * Why it is worth a whole script rather than six assertions in `acceptance.ts`:
 * the failure it catches is invisible to every other check. `acceptance` drives
 * the API and never reads a byte of HTML, so a screen whose module was renamed,
 * whose stylesheet was never imported, or that quietly began fetching a font
 * from a CDN, passes all 140 of its checks and ships unstyled. That is not a
 * thought experiment — the theme deletion left exactly such a bug behind, and it
 * was found by doing this by hand.
 *
 * Isolation is the same as acceptance's: a scratch schema (`routeaudit`) inside
 * the database `TEST_DATABASE_URL` names, dropped on the way out. The first
 * port is different so the two scripts can run at once without racing.
 *
 * Usage:
 *   npm run route:audit                     drop → migrate → build → serve → walk
 *   npm run route:audit -- --skip-build     reuse the existing `.next` build
 *   npm run route:audit -- --keep           leave the scratch schema to inspect
 */
import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import {
  ROUTE_WALK,
  auditPage,
  bodyClasses,
  resolveHref,
  routePaths,
  stylesheetHrefs,
  type PageFinding,
  type RouteSession,
  type RouteSpec,
} from '../src/lib/route-audit';

import {
  Session,
  csvForm,
  freePort,
  loadEnv,
  resetScratchSchema,
  scratchSource,
  scratchUrl,
  shell,
  startServer,
  stopServer,
  waitForServer,
} from './harness';

/* ------------------------------------------------------------------ config */

loadEnv();

const SCRATCH_SCHEMA = 'routeaudit';
const FIRST_PORT = 3251;

const SHOP = {
  name: 'ร้านกาแฟ เหลี่ยมนอก',
  branchLabel: 'สาขาหลัก',
  taxId: '1103700123456',
  isVatRegistered: true,
  vatRate: 7,
  receiptPrefix: 'RA',
};

const ADMIN = { fullName: 'ผู้จัดการ เหลี่ยมนอก', phone: '0800000400', password: 'route-admin-1' };
const CASHIER = { fullName: 'มาลี เหลี่ยมนอก', phone: '0800000401', password: 'route-cashier-1' };

/**
 * The customer, enrolled through `POST /api/v1/members` like any other.
 *
 * A member session is the only honest way to open `/shop/*` — those screens ask
 * who is signed in, and an employee's answer is not a customer's — and until ADR
 * 0010 the only way to get one was a SQL insert, which is why the member area used
 * to be reachable only on a deployment somebody had reached into.
 */
const MEMBER = { fullName: 'สมชาย สมาชิก', phone: '0800000402', password: 'route-member-1' };

const COFFEE = { barcode: 'LNR0000001', name: 'กาแฟเหลี่ยมนอก 250 มล.', cost: 60, price: 107, stock: 12 };

const CATALOGUE_CSV = [
  'บาร์โค้ด,ชื่อสินค้า,หมวดหมู่,ราคาทุน,ราคาขาย,จำนวนสต็อก',
  `${COFFEE.barcode},${COFFEE.name},เครื่องดื่ม,${COFFEE.cost},${COFFEE.price},${COFFEE.stock}`,
].join('\r\n');

/* ------------------------------------------------------------------ plumbing */

/** Set once in `main`; every fetch goes through it. */
let base = '';

interface Fetched {
  status: number;
  finalPath: string;
  /** Every path in the redirect chain, including the one requested. */
  chain: string[];
  html: string;
}

/**
 * Fetches a page, following redirects by hand.
 *
 * By hand because the walk has to know *where* a request ended up: fifteen of
 * these eighteen paths redirect to `/login` when handed no session, so a check
 * that only looked at the status code would call the login page eighteen
 * different screens. `redirect: 'follow'` would hide the chain and
 * `redirect: 'error'` would hide the page.
 */
async function fetchPage(path: string, cookie: string): Promise<Fetched> {
  const chain: string[] = [];
  let current = `${base}${path}`;

  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetch(current, {
      headers: cookie ? { cookie } : {},
      redirect: 'manual',
    });
    const html = await response.text();
    const here = new URL(current);
    chain.push(`${here.pathname}${here.search}`);

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }

    return { status: response.status, finalPath: here.pathname, chain, html };
  }

  throw new Error(`${path} redirected more than five times: ${chain.join(' → ')}`);
}

/** The CSS at one href, fetched once however many routes link it. */
async function loadSheets(hrefs: string[], path: string, cache: Map<string, string>) {
  const sheets: { href: string; css: string }[] = [];
  const offSite: PageFinding[] = [];

  for (const href of hrefs) {
    const absolute = resolveHref(href, path, base);
    if (absolute === null) {
      offSite.push({
        route: path,
        rule: 'off-site-reference',
        text: `${href} (a stylesheet on another origin)`,
      });
      continue;
    }

    let css = cache.get(absolute);
    if (css === undefined) {
      const response = await fetch(absolute);
      if (!response.ok) {
        offSite.push({
          route: path,
          rule: 'no-stylesheet',
          text: `${href} answered ${response.status}`,
        });
        continue;
      }
      css = await response.text();
      cache.set(absolute, css);
    }

    sheets.push({ href, css });
  }

  return { sheets, offSite };
}

/* ------------------------------------------------------------------ the run */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const skipBuild = argv.includes('--skip-build');
  const keep = argv.includes('--keep');

  const source = scratchSource();
  if (source === null) {
    throw new Error('Neither TEST_DATABASE_URL nor DATABASE_URL is set. Run `npm run setup` first.');
  }

  let child: ChildProcess | null = null;
  const findings: PageFinding[] = [];
  const passed: string[] = [];
  const failed: string[] = [];
  const sheetsCache = new Map<string, string>();

  console.log('');
  console.log('POS — every screen, styled');
  console.log('=========================');

  try {
    const scratch = scratchUrl(source, SCRATCH_SCHEMA);

    console.log(`\nScratch schema: ${SCRATCH_SCHEMA} (in ${new URL(source).pathname.replace(/^\//, '')})`);
    console.log('\n1. Resetting the scratch schema');
    await resetScratchSchema(source, SCRATCH_SCHEMA, true);
    console.log('  • dropped and recreated, so this starts from empty');

    console.log('\n2. Applying migrations');
    shell('prisma migrate deploy', 'npx prisma migrate deploy', {
      ...process.env,
      DATABASE_URL: scratch,
    });

    if (skipBuild) {
      console.log('\n3. Build: skipped (--skip-build); reusing the existing .next output');
      if (!existsSync('.next/BUILD_ID')) {
        throw new Error('There is no .next build to reuse. Run without --skip-build.');
      }
    } else {
      console.log('\n3. Building');
      shell('next build', 'npx next build');
    }

    const port = await freePort(FIRST_PORT);
    base = `http://127.0.0.1:${port}`;
    console.log(`\n4. Serving the build on ${base}`);
    const started = startServer(scratch, port);
    child = started.child;
    await waitForServer(base, child, started.log);
    console.log('  • up');

    console.log('\n5. Setting up a shop the way a renter would');
    const cookies = await bootstrap(scratch);
    console.log('  • shop, three accounts, a catalogue, a sale and a pre-order');

    console.log(`\n6. Walking ${routePaths().length} screens (${ROUTE_WALK.length} requests)`);
    for (const spec of ROUTE_WALK) {
      const walked = await fetchPage(spec.path, cookies[spec.session]);
      const expected = spec.landsOn;

      const label = `${spec.path} — ${spec.label} (${spec.session})`;
      if (walked.status !== 200) {
        failed.push(`${label}: answered ${walked.status}`);
        continue;
      }
      if (walked.finalPath !== expected) {
        failed.push(`${label}: landed on ${walked.finalPath}, expected ${expected}`);
        continue;
      }

      const { sheets, offSite } = await loadSheets(stylesheetHrefs(walked.html), walked.finalPath, sheetsCache);
      const pageFindings = [
        ...auditPage({ route: spec, html: walked.html, sheets, baseOrigin: base }),
        ...offSite,
      ];

      if (pageFindings.length === 0) {
        passed.push(label);
      } else {
        failed.push(label);
        findings.push(...pageFindings);
      }
      console.log(
        pageFindings.length === 0
          ? `  ✓ ${spec.path}  ${spec.label}`
          : `  ✗ ${spec.path}  ${spec.label}  → ${pageFindings.length} finding(s)`,
      );
    }

    console.log('\n7. The theme cookie decides the first byte of HTML');
    for (const theme of ['dark', 'light'] as const) {
      const walked = await fetchPage('/admin/dashboard', `${cookies.admin}; pos_theme=${theme}`);
      const hasDark = bodyClasses(walked.html).includes('dark');
      const wanted = theme === 'dark';
      if (hasDark === wanted) {
        passed.push(`pos_theme=${theme} → body${wanted ? ' class="dark"' : ' without the dark class'}`);
        console.log(`  ✓ pos_theme=${theme} puts ${wanted ? '' : 'no '}dark class on <body>`);
      } else {
        failed.push(`pos_theme=${theme} rendered the wrong theme`);
        console.log(`  ✗ pos_theme=${theme} rendered the wrong theme`);
      }
    }

    console.log('\n8. Shutting the server down');
    await stopServer(child);
    child = null;
    console.log('  • stopped');

    if (keep) {
      console.log(`\n9. Scratch schema kept: ${SCRATCH_SCHEMA}`);
    } else {
      await resetScratchSchema(source, SCRATCH_SCHEMA, false);
      console.log('\n9. Scratch schema dropped');
    }
  } catch (error) {
    if (child !== null) {
      await stopServer(child);
    }
    if (keep) {
      console.log(`Scratch schema kept for inspection: ${SCRATCH_SCHEMA}`);
    }
    console.error(`\nRoute audit could not complete:\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(`\nroute audit: ${findings.length} finding(s)`);
    console.error('');
    for (const finding of findings) {
      console.error(`  ${finding.route}  ${finding.rule}  ${finding.text}`);
    }
    console.error('');
    console.error('  A class the page renders that no stylesheet it loads defines is an unstyled');
    console.error('  element in front of a customer. Check the CSS module is imported, and that');
    console.error('  nothing is being fetched from another origin (ADR 0003).');
  }

  console.log(
    failed.length === 0
      ? `\nroute audit: ${passed.length} passed, 0 failed — every screen rendered styled`
      : `\nroute audit: ${passed.length} passed, ${failed.length} FAILED`,
  );
  for (const failure of failed) {
    console.error(`  ✗ ${failure}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

/**
 * Creates everything the eighteen screens need to render *with content*.
 *
 * Through the API wherever an API exists, because that is the path a renter
 * takes and it keeps this script from depending on internals. The two things it
 * cannot do that way are the member account (no surface creates customers) and
 * the pre-order's customer link, and both are written with SQL against the
 * scratch schema — with the schema qualified explicitly, since `pg` ignores the
 * `?schema=` parameter Prisma understands.
 */
async function bootstrap(scratch: string): Promise<Record<RouteSession, string>> {
  const anonymous = new Session(() => base);

  await anonymous.call('/api/v1/setup', {
    method: 'POST',
    body: {
      shop: {
        name: SHOP.name,
        branchLabel: SHOP.branchLabel,
        taxId: SHOP.taxId,
        isVatRegistered: SHOP.isVatRegistered,
        vatRate: SHOP.vatRate,
        receiptPrefix: SHOP.receiptPrefix,
      },
      admin: { fullName: ADMIN.fullName, phone: ADMIN.phone, password: ADMIN.password },
    },
  });

  const admin = new Session(() => base);
  await admin.login({ identifier: ADMIN.phone, password: ADMIN.password });

  await admin.call('/api/v1/staff', {
    method: 'POST',
    body: { fullName: CASHIER.fullName, phone: CASHIER.phone, role: 'employee', password: CASHIER.password },
  });

  // The customer is enrolled the way the shop enrolls one (ADR 0010). This used to
  // be a SQL insert, because no route created customers — which is exactly the gap
  // that made the member area unreachable on a fresh install.
  const enrolledMember = await admin.call<{ id: string }>('/api/v1/members', {
    method: 'POST',
    body: { fullName: MEMBER.fullName, phone: MEMBER.phone, password: MEMBER.password },
  });
  const memberId = enrolledMember.id;

  await admin.postForm('/api/v1/products/import', csvForm(CATALOGUE_CSV, 'commit'));

  const cashier = new Session(() => base);
  await cashier.login({ identifier: CASHIER.phone, password: CASHIER.password });

  const shift = await cashier.call<{ id: number }>('/api/v1/shifts/current', {
    method: 'POST',
    body: { initialCash: 500 },
  });

  const [coffee] = await admin.call<{ id: string }[]>(
    `/api/v1/products?barcode=${COFFEE.barcode}`,
  );
  if (!coffee) {
    throw new Error('The catalogue import did not produce the product the screens need');
  }

  // A completed sale gives the dashboard, the reports, the register's history
  // and the audit trail something to render. An empty database renders empty
  // states, which are styled too — but only the populated screen exercises the
  // tables, the money formatting and the receipt.
  await cashier.call('/api/v1/orders', {
    method: 'POST',
    body: {
      type: 'pos_walkin',
      shiftId: shift.id,
      lines: [{ productId: coffee.id, quantity: 1 }],
      settlement: { cash: COFFEE.price },
    },
  });

  const member = new Session(() => base);
  await member.login({ identifier: MEMBER.phone, password: MEMBER.password });

  await member.call('/api/v1/orders', {
    method: 'POST',
    body: { type: 'preorder', lines: [{ productId: coffee.id, quantity: 2 }] },
  });

  /*
   * The account portal reads the points ledger, so the customer needs one: a walk-in
   * sale rung up under their own number posts the points the portal shows. Without
   * this the portal renders its empty state, which is styled too — but only a
   * populated ledger exercises the earn/spend rows this screen exists for.
   */
  await cashier.call('/api/v1/orders', {
    method: 'POST',
    body: {
      type: 'pos_walkin',
      shiftId: shift.id,
      customerId: memberId,
      lines: [{ productId: coffee.id, quantity: 1 }],
      settlement: { cash: COFFEE.price },
    },
  });

  return {
    none: '',
    admin: admin.cookieHeader(),
    cashier: cashier.cookieHeader(),
    member: member.cookieHeader(),
  };
}

void main();
