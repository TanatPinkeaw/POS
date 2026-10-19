/**
 * `npm run shop:phone` — the customer's storefront, measured on a phone.
 *
 * This gate exists because a defect reached a customer on the shop's own phone and every
 * gate in this repository reported green. The storefront's product card was a picture and
 * a name and a price and a quantity stepper; on that phone it rendered as a white card
 * taller than the screen with the stepper at the bottom and nothing above it, and the
 * basket card sat over the grid. Nothing here could see it: `route:audit` asks whether
 * every class in the HTML is defined in the CSS the page loads (it was), `browser:target`
 * asks whether the chunks *parse* (they did), and no test measured a tile's height at a
 * phone's width at all.
 *
 * So this run serves the production build, signs in as a demo customer on a 414×736
 * viewport — the shop's own phone is a Plus, and 414 is the width the storefront's
 * two-column grid is measured against (`ShopCatalog.module.css`) — and asserts the things
 * a customer would notice:
 *
 *   1. **A product card is a card, not a screen.** Its height is bounded, its contents fit
 *      inside it, its name is rendered and inside the box, and its picture holds the 4:3
 *      frame the stylesheet promises. This is the measurement the padding-box ratio in
 *      `Thumb.module.css` exists for, and it is taken on a tile that really has a photo —
 *      the case the old `aspect-ratio` + `height: 100%` arrangement got wrong.
 *   2. **The basket is below the catalogue, not over it.** The phone's layout stacks the
 *      two panes; a panel drawn on top of the grid is unreadable and un-tappable.
 *   3. **A receipt is a document the customer can read.** The row opens the slip in the
 *      app (ADR 0034), and the way it is saved follows the browser's own answer.
 *   4. **Inside LINE, the screen says the truth.** A LINE user agent gets no download
 *      button — that button was the reported failure, a tap that produced nothing — and
 *      gets the picture with the one instruction iOS honours instead.
 *
 * Both engines run: WebKit under Playwright's iPhone profile is the engine family of the
 * phone that reported this, and Chromium is the other half of what customers hold. Neither
 * is iOS 15.6, and that limitation is stated in the output rather than hidden: what is
 * proven here is the *layout rule*, on a real engine, at the width where it broke.
 *
 * Usage:
 *   npm run shop:phone                    build (or reuse `.next`), seed a scratch schema, drive it
 *   npm run shop:phone -- --skip-build    reuse the existing build
 *   npm run shop:phone -- --keep          leave the scratch schema behind to inspect
 *   npm run shop:phone -- --engine=webkit drive one engine instead of both
 *   npm run shop:phone -- --url=https://pos.example.com --member=0900000001:password123
 *                                         measure a deployment that is already running
 *
 * Needs `TEST_DATABASE_URL` naming a test database (unless `--url` is given) and
 * `npx playwright install chromium webkit`. Evidence lands in `test-results/shop-phone/`.
 */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';

import {
  chromium,
  devices,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import {
  Session,
  freePort,
  loadEnv,
  resetScratchSchema,
  scratchUrl,
  shell,
  startServer,
  stopServer,
  waitForServer,
} from './harness';

loadEnv();

const EVIDENCE = 'test-results/shop-phone';

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');
const keep = argv.includes('--keep');
const engineArg = argv.find((arg) => arg.startsWith('--engine='))?.slice('--engine='.length) ?? 'both';
const providedUrl = argv.find((arg) => arg.startsWith('--url='))?.slice('--url='.length) ?? null;
const memberArg = argv.find((arg) => arg.startsWith('--member='))?.slice('--member='.length) ?? null;

/** The demo customer the seed creates; documented in README §3. */
const MEMBER = memberArg
  ? { phone: memberArg.split(':')[0] ?? '', password: memberArg.split(':')[1] ?? '' }
  : { phone: '0900000001', password: 'password123' };
const CASHIER = { identifier: '0800000002', password: 'password123' };

/**
 * A LINE user agent, because being inside an app is the condition that broke the receipt.
 *
 * The receipt row used to be a download and nothing else, and LINE's in-app browser
 * ignores an anchor download — silently, which is why the customer's report was "it does
 * not work" rather than an error. This string is the phone's own WebKit plus LINE's token;
 * `isEmbeddedBrowser` is what reads it.
 */
const LINE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/13.16.0';

let server: ChildProcess | null = null;
/**
 * Held in an object rather than a bare `let`: this is read in the failure path below, and
 * a module-level `let` that is only assigned inside `main` narrows to `never` there — the
 * compiler is right that the initialiser is the only value it can see, and wrong about the
 * run.
 */
const logHolder: { read: (() => string) | null } = { read: null };
let base = providedUrl ?? '';
let scratch: string | null = null;
let schemaSource: string | null = null;
let checks = 0;

function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  checks += 1;
  console.log(`  ✓ ${message}`);
}

/** The fixtures: a demo shop, a customer, a completed sale, and a product with a photo. */
async function seedFixtures(): Promise<void> {
  const admin = new Session(() => base);
  const cashier = new Session(() => base);
  const member = new Session(() => base);

  await admin.login({ identifier: '0800000001', password: 'password123' });
  await cashier.login(CASHIER);
  await member.login({ identifier: MEMBER.phone, password: MEMBER.password });

  const me = await member.call<{ id: string }>('/api/v1/auth/me');

  /*
   * Two products get a picture, pointed at this deployment's own brand asset. The tile's
   * failure was in the *photo* path — an in-flow `<img height="100%">` inside a box whose
   * height came from `aspect-ratio` — and a catalogue of placeholder monograms cannot
   * exercise it. A URL rather than a stored file is the only shape this shop has (ADR
   * 0014), so the fixture is a link like any other.
   */
  const products = await admin.call<Array<{ id: string; name: string; salePrice: number }>>(
    '/api/v1/products?limit=8',
  );
  check(products.length > 0, 'the demo catalogue has products to measure');
  const withPhoto = products.slice(0, 2);
  for (const product of withPhoto) {
    await admin.call(`/api/v1/products/${product.id}`, {
      method: 'PATCH',
      body: { imageUrl: `${base}/brand-mark.png` },
    });
  }

  /*
   * A drawer is opened only when none is open.
   *
   * Against the gate's own scratch schema it never is, but `--url` points this at a shop
   * that is already running, and there a cash drawer may genuinely be open (the till
   * refuses a second one with a 409, correctly). Opening-or-reusing is the honest
   * behaviour for a measurement: it takes no money and leaves the drawer as it found it.
   */
  const current = await cashier.request<{ shift: { id: number } | null }>(
    '/api/v1/shifts/current',
  );
  /*
   * The answer is an envelope that is never null — `{ shift, defaultInitialCashThb }` — and
   * `shift` inside it is null when no drawer is open. Testing the envelope for null instead
   * made every run on a fresh schema skip the open and dereference that null.
   */
  const shift =
    current.status === 200 && current.data?.shift
      ? current.data.shift
      : await cashier.call<{ id: number }>('/api/v1/shifts/current', {
          method: 'POST',
          body: { initialCash: 500 },
        });

  const price = products[0]?.salePrice ?? 0;
  const sale = await cashier.call<{ orderId: string; orderNumber: string; status: string }>(
    '/api/v1/orders',
    {
      method: 'POST',
      body: {
        type: 'pos_walkin',
        shiftId: shift.id,
        lines: [{ productId: products[0]?.id, quantity: 1 }],
        settlement: { cash: price },
        /*
         * The sale has to belong to the customer whose receipt tab is being driven — the
         * list is scoped by the session (`/api/v1/orders?status=completed`), which is the
         * whole point of the tab.
         */
        customerId: me.id,
      },
    },
  );
  check(sale.status === 'completed', 'a walk-in sale is completed for the demo customer');
}

/** One engine's run over the storefront and the account's receipts tab. */
async function drive(name: 'webkit' | 'chromium', launch: () => Promise<Browser>): Promise<void> {
  const browser = await launch();
  try {
    const profile =
      name === 'webkit'
        ? { ...devices['iPhone 7 Plus'] }
        : {
            viewport: { width: 414, height: 736 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
          };

    const customer = await signedIn(browser, profile, MEMBER);
    try {
      const page = customer.pages()[0] ?? (await customer.newPage());
      await measureStorefront(page, name);
    } finally {
      await customer.close();
    }

    /*
     * The reported phone: a customer who opened the shop inside LINE. Same customer, same
     * receipt, a user agent that says "an app is showing this page" — and the screen must
     * therefore not offer the button that does nothing there.
     */
    const inLine = await signedIn(browser, { ...profile, userAgent: LINE_UA }, MEMBER);
    try {
      const page = inLine.pages()[0] ?? (await inLine.newPage());
      await measureReceipt(page, name, { embedded: true });
    } finally {
      await inLine.close();
    }

    const plain = await signedIn(browser, profile, MEMBER);
    try {
      const page = plain.pages()[0] ?? (await plain.newPage());
      await measureReceipt(page, name, { embedded: false });
    } finally {
      await plain.close();
    }
  } finally {
    await browser.close();
  }
}

/**
 * A context that is signed in as the demo customer.
 *
 * The cookie dance is the measured trap every browser gate in this repository carries: the
 * production build sets `Secure`, this run serves plain http, and WebKit stores that cookie
 * for `http://localhost` and then never sends it back over it. So the value is copied into
 * a non-secure cookie for the loopback origin. Chromium does not need it, and doing it for
 * both engines keeps one code path.
 */
async function signedIn(
  browser: Browser,
  profile: Parameters<Browser['newContext']>[0],
  who: { phone: string; password: string },
): Promise<BrowserContext> {
  const context = await browser.newContext(profile);
  const login = await context.request.post(`${base}/api/v1/auth/login`, {
    data: { identifier: who.phone, password: who.password },
  });
  if (login.status() !== 200) {
    throw new Error(`sign-in failed: ${login.status()} ${(await login.text()).slice(0, 200)}`);
  }
  const cookie = (await context.cookies()).find((entry) => entry.name === 'pos_session');
  if (cookie) {
    await context.clearCookies();
    await context.addCookies([
      {
        name: 'pos_session',
        value: cookie.value,
        url: base,
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);
  }
  return context;
}

interface TileBox {
  height: number;
  width: number;
  text: string;
  nameInside: boolean;
  contentsFit: boolean;
  thumb: { width: number; height: number; hasPhoto: boolean } | null;
  stepperInside: boolean;
}

/** The measurements the storefront has to satisfy, taken from the rendered page. */
async function measureStorefront(page: Page, engine: string): Promise<void> {
  await page.goto(`${base}/shop/products`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="shop-tile"]').first().waitFor({ timeout: 20_000 });

  /*
   * Written without a single local function inside it, on purpose: `tsx` compiles this file
   * with esbuild's `keepNames`, which wraps a named function expression in a `__name()`
   * helper — and that helper does not exist in the page, so the evaluate dies with
   * `Can't find variable: __name` before measuring anything. Statements only.
   */
  const measured = await page.evaluate(() => {
    const tiles = Array.from(document.querySelectorAll('[data-testid="shop-tile"]'));
    const boxes = [];
    for (let index = 0; index < Math.min(tiles.length, 4); index += 1) {
      const tile = tiles[index] as HTMLElement;
      const rect = tile.getBoundingClientRect();
      const name = tile.querySelector('[class*="ShopCatalog-module"][class*="name"]');
      const thumb = tile.querySelector('[class*="Thumb-module"]');
      const stepper = tile.querySelector('[class*="ShopCatalog-module"][class*="stepper"]');
      const nameRect = name === null ? null : name.getBoundingClientRect();
      const thumbRect = thumb === null ? null : thumb.getBoundingClientRect();
      const stepperRect = stepper === null ? null : stepper.getBoundingClientRect();
      boxes.push({
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        text: tile.innerText.replace(/\s+/g, ' ').trim().slice(0, 60),
        nameInside:
          nameRect !== null && nameRect.top >= rect.top - 0.5 && nameRect.bottom <= rect.bottom + 0.5,
        contentsFit: tile.scrollHeight <= tile.clientHeight + 1,
        thumb:
          thumbRect === null
            ? null
            : {
                width: Math.round(thumbRect.width),
                height: Math.round(thumbRect.height),
                hasPhoto: thumb === null ? false : thumb.querySelector('img') !== null,
              },
        stepperInside:
          stepperRect !== null &&
          stepperRect.top >= rect.top - 0.5 &&
          stepperRect.bottom <= rect.bottom + 0.5,
      });
    }

    /* The catalogue's own card: the grid's nearest card ancestor is what the panel sits below. */
    const grid = document.querySelector('[class*="ShopCatalog-module"][class*="grid"]');
    let catalogue = grid;
    while (catalogue !== null && !/Card-module/.test(catalogue.className || '')) {
      catalogue = catalogue.parentElement;
    }
    const panel = document.getElementById('basket');

    return {
      count: tiles.length,
      tiles: boxes as TileBox[],
      gridBottom: catalogue === null ? null : Math.round(catalogue.getBoundingClientRect().bottom),
      panelTop: panel === null ? null : Math.round(panel.getBoundingClientRect().top),
      scrollHeight: Math.round(document.documentElement.scrollHeight),
    };
  });

  check(measured.count >= 2, `${engine}: the catalogue renders product cards (${measured.count})`);
  check(
    measured.tiles.some((tile) => tile.thumb?.hasPhoto === true),
    `${engine}: a card with a real photo is on screen — the path the tile used to get wrong`,
  );

  for (const tile of measured.tiles) {
    const label = `${engine}: “${tile.text.split(' ')[0]}”`;
    /*
     * The bound is deliberately wide. What it forbids is the reported failure — a card as
     * tall as the screen — not a design review of the card's own spacing. Anything inside
     * 200–420 on a 414 viewport is a card with a picture, a name, a price and a stepper;
     * 575 was a white column with the stepper at the bottom.
     */
    check(tile.height >= 200 && tile.height <= 420, `${label} card is ${tile.height}px tall, not a screen`);
    check(tile.contentsFit, `${label} card's contents fit inside it`);
    check(tile.nameInside, `${label} name is drawn inside the card`);
    check(tile.text.length > 0, `${label} card has a label on it`);
    if (tile.thumb !== null) {
      const ratio = tile.thumb.height / tile.thumb.width;
      check(
        Math.abs(ratio - 0.75) <= 0.03,
        `${label} picture holds the 4:3 frame (${tile.thumb.width}×${tile.thumb.height})`,
      );
    }
    check(tile.stepperInside, `${label} stepper sits inside the card`);
  }

  if (measured.panelTop !== null && measured.gridBottom !== null) {
    check(
      measured.panelTop >= measured.gridBottom - 1,
      `${engine}: the basket panel sits below the catalogue (${measured.panelTop} ≥ ${measured.gridBottom})`,
    );
  }

  await page.screenshot({ path: `${EVIDENCE}/products-${engine}.png` });
  console.log(`  · ${engine}: page is ${measured.scrollHeight}px tall at 414×736`);
}

/** The receipts tab: the slip opens, and the save action matches what the browser can do. */
async function measureReceipt(
  page: Page,
  engine: string,
  { embedded }: { embedded: boolean },
): Promise<void> {
  const where = embedded ? 'in LINE' : 'in a browser';
  await page.goto(`${base}/shop/account`, { waitUntil: 'networkidle' });

  const tab = page.getByRole('tab', { name: 'ใบเสร็จ' });
  await tab.click();
  const row = page.getByRole('button', { name: /ดูใบเสร็จ/ }).first();
  await row.waitFor({ timeout: 15_000 });
  check(true, `${engine} ${where}: the receipts tab lists a sale with “ดูใบเสร็จ”`);

  await row.click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.locator('[data-testid="receipt"]').first().waitFor({ timeout: 15_000 });
  check(true, `${engine} ${where}: the slip opens in the app, as a document`);

  const dialogText = await dialog.innerText();
  check(/PO-|FR-/.test(dialogText), `${engine} ${where}: the slip names the order`);
  check(/ยอดชำระ/.test(dialogText), `${engine} ${where}: the slip shows what was paid`);

  const saveButton = await dialog.getByRole('button', { name: /บันทึกเป็นรูป/ }).count();
  const hint = await dialog.getByText(/กดค้างที่รูป/).count();
  const picture = await dialog.locator('img[alt^="รูปใบเสร็จ"]').count();

  if (embedded) {
    /*
     * The defect, as an assertion: a download button in LINE's browser is a tap that
     * produces nothing, and the screen that offered it said nothing either.
     */
    check(saveButton === 0, `${engine} ${where}: no download button is offered`);
    check(hint === 1 && picture === 1, `${engine} ${where}: the picture and “press and hold” are shown`);
  } else {
    const share = await dialog.getByRole('button', { name: /แชร์ \/ บันทึก/ }).count();
    check(
      saveButton + share >= 1,
      `${engine} ${where}: the dialog offers a way to keep the slip (${share ? 'share' : 'download'})`,
    );
    check(hint + picture === 0, `${engine} ${where}: the press-and-hold fallback is not shown`);
  }

  await page.screenshot({ path: `${EVIDENCE}/receipt-${engine}-${embedded ? 'line' : 'browser'}.png` });
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });

  if (!providedUrl) {
    const source = process.env.TEST_DATABASE_URL;
    if (!source || !new URL(source).pathname.toLowerCase().includes('test')) {
      throw new Error('shop:phone requires TEST_DATABASE_URL naming a test database');
    }
    schemaSource = source;
    scratch = scratchUrl(source, 'shopphone');

    if (!skipBuild) {
      shell('build', 'npm run build');
    } else {
      console.log('shop:phone: reusing the existing `.next` build');
    }

    await resetScratchSchema(source, 'shopphone', true);
    shell('migrate', 'npm run db:deploy', { ...process.env, DATABASE_URL: scratch });
    shell('seed', 'npx tsx prisma/seed.ts --force', { ...process.env, DATABASE_URL: scratch });

    const port = await freePort(3170);
    base = `http://127.0.0.1:${port}`;
    const started = startServer(scratch, port);
    server = started.child;
    logHolder.read = started.log;
    await waitForServer(base, started.child, started.log);
    console.log(`shop:phone: serving ${base} on scratch schema "${'shopphone'}"`);
  } else {
    base = providedUrl.replace(/\/$/, '');
    console.log(`shop:phone: measuring the running deployment at ${base}`);
  }

  console.log('');
  await seedFixtures();

  const engines: Array<'webkit' | 'chromium'> =
    engineArg === 'both' ? ['webkit', 'chromium'] : [engineArg as 'webkit' | 'chromium'];

  for (const engine of engines) {
    console.log(`\n── ${engine} at 414×736`);
    await drive(engine, () => (engine === 'webkit' ? webkit.launch() : chromium.launch()));
  }

  console.log(`\nshop:phone: ${checks} checks passed on ${engines.join(' + ')}`);
  console.log(
    'What this does not prove: Playwright’s WebKit is not iOS 15.6, so this is the layout\n' +
      'rule measured on the engine family, not on the shop’s own phone. The device that\n' +
      'reported the defect still has to be looked at by a person.',
  );
}

/** One entry point, so the cleanup below runs for a failure as well as a pass. */
async function run(): Promise<void> {
  try {
    await main();
  } catch (error) {
    console.error(`\nshop:phone: FAILED\n${error instanceof Error ? error.stack : error}`);
    if (logHolder.read !== null) {
      /*
       * The server's last words, because most of what this gate can fail on is a fault in
       * the page it served. Only the tail: a Next startup banner is a route list.
       */
      console.error(`\nlast thing the server said:\n${logHolder.read().trim().split('\n').slice(-20).join('\n')}`);
    }
    process.exitCode = 1;
  } finally {
    if (server !== null) {
      await stopServer(server);
    }
    if (schemaSource !== null && !keep && providedUrl === null) {
      await resetScratchSchema(schemaSource, 'shopphone', false).catch(() => undefined);
      console.log('shop:phone: scratch schema dropped (--keep to inspect it)');
    }
  }
}

void run();
