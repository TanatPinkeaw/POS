/**
 * `npm run google:door` — the Google sign-in door in a real browser (ADR 0020 §1,
 * amended).
 *
 * The defect this exists for is invisible to every other gate. `google.accounts.id
 * .initialize` was called without `ux_mode`, so every device got Google's default —
 * `popup` — while Google's supported-browser page says "Due to ITP redirect mode is
 * required for iOS". The shop's customers hold iPhones (ADR 0031). A unit test can assert
 * the *value* a phone should get (`tests/google-door.test.ts`), but only a browser can show
 * that the value is what the phone's page actually hands Google, and only a browser can
 * walk the other half: the credential coming back as a **form POST** to the landing and the
 * customer ending up where the flow says.
 *
 * So this run serves the production build, opens it in WebKit with Playwright's iPhone
 * profile, and replaces Google's own script with a stub that records what it was asked for.
 * Four things are then asserted, and each one is a thing no other gate can see:
 *
 *   1. A phone's page asks Google for `ux_mode: 'redirect'` **with** a `login_uri`, and the
 *      `login_uri` is this deployment's own public address — the address Google compares
 *      against the registered redirect URI.
 *   2. A desktop's page still asks for neither, which is the promise that this change did
 *      not quietly move a desktop off Google's preferred shape.
 *   3. A real cross-origin form POST — what Google's button does — lands the browser on the
 *      front door's phone step, with the proof in an httpOnly cookie rather than a session.
 *   4. The completion, run *in the browser* so that the cookie is the thing that carries it,
 *      and then the shop's own page renders for that customer.
 *   5. **Where the front door's arrival words live after they have been read**, which is a
 *      client behaviour and therefore invisible to every gate that reads HTML or calls the
 *      API: a notice comes out of the address once it has been painted (the shop's operator
 *      re-opened a landing URL and was told a sign-in had failed), a step keeps its address,
 *      and the callback opened with nothing on it lands on the front door saying nothing.
 *
 * **Two engines, and the second one is a measurement rather than a preference.** The door's
 * own half runs in WebKit under an iPhone profile — that is the half only a phone's engine
 * can answer — and the landing's *consequences* run in Chromium, because this gate serves a
 * production build over **plain http** and there is a measured difference between the two
 * engines about that: a `Secure` cookie is stored by WebKit for `http://localhost` and then
 * never sent back over it, while Chromium treats loopback as secure and sends it. (Probed
 * both ways: drop `Secure` and WebKit sends it.) So the phone step in WebKit would find no
 * handoff and the completion could not be driven there at all. That difference is also the
 * deployment requirement, stated once and for all: a production build on any address that is
 * not loopback, without TLS, sets cookies no browser will send — which is why the shop reaches
 * its customers through the tunnel rather than over plain http on the LAN.
 *
 * **What it does not prove, said plainly.** This is WebKit, the same engine family as iOS,
 * but it is not iOS and not Safari 15.6: Playwright's iPhone profile is a user agent, a
 * viewport and touch points, so the parts of this that are *Safari's* behaviour (ITP, the
 * Universal Link handoff, whether the popup would have been blocked) stay unmeasured until a
 * real phone runs it. Google's servers are not contacted either: the stub is the point, so
 * what is proven here is the configuration this deployment sends and the landing it serves.
 * And the second engine is not a phone: the completion proves what the *server* does with a
 * handoff a browser carried back, in an engine that hands it back over loopback.
 *
 * Usage:
 *   npm run google:door                 build (or reuse), serve the scratch schema, drive it
 *   npm run google:door -- --skip-build reuse the existing `.next` build
 *   npm run google:door -- --engine=chromium   on a machine without WebKit installed
 *   npm run google:door -- --keep       leave the scratch schema to inspect
 *
 * Needs `TEST_DATABASE_URL` naming a test database, and `npx playwright install webkit`.
 */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
  chromium,
  devices,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { GOOGLE_PENDING_COOKIE } from '../src/lib/google-pending';
import { CURRENT_CUSTOMER_NOTICE_VERSION } from '../src/lib/privacy-notice';

import { GOOGLE_STUB_CLIENT_ID, startGoogleStub, type GoogleStub } from './google-stub';
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

const schema = 'googledoor';
const source = process.env.TEST_DATABASE_URL;
if (!source || !new URL(source).pathname.toLowerCase().includes('test')) {
  throw new Error('google:door requires TEST_DATABASE_URL naming a test database');
}
const scratch = scratchUrl(source, schema);
const skipBuild = process.argv.includes('--skip-build');
const keep = process.argv.includes('--keep');
const engine = process.argv.find((arg) => arg.startsWith('--engine='))?.slice(9) ?? 'webkit';

const ADMIN = { fullName: 'ผู้ดูแลกูเกิล', phone: '0800000600', password: 'google-door-admin-1' };
const SHOP_NAME = 'ร้านทดสอบกูเกิล';
const SHOP_PATH = '/api/v1/auth/google/redirect';

let server: ChildProcess | null = null;
/** The engine the door's own half is driven in: WebKit, unless `--engine=chromium`. */
let phoneBrowser: Browser | null = null;
/**
 * The engine the landing's *consequences* are driven in — always Chromium, even when the
 * phone half is WebKit.
 *
 * Measured, not preferred: WebKit stores a `Secure` cookie for `http://localhost` and then
 * never hands it back over that origin, while Chromium treats loopback as a secure context
 * and sends it (probed both ways — remove `Secure` and WebKit sends it too). This run serves
 * a **production build over plain http**, so the handoff cookie is `Secure`, so the phone
 * step in WebKit would find no handoff and the completion could not be driven at all. The
 * split is only about which engine can answer which question; both use the same iPhone
 * profile, and nothing about the flow differs between them.
 *
 * It is also the honest shape of the deployment requirement: a production build on a
 * non-loopback address without TLS sets cookies no browser will send, which is why the shop
 * reaches its customers through the tunnel and not over plain http on the LAN.
 */
let flowBrowser: Browser | null = null;
let googleStub: GoogleStub | null = null;
/** The server's own output, printed when a check fails — most of this run's diagnoses are in it. */
let serverLog: (() => string) | null = null;
let base = '';
let checks = 0;

function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  checks += 1;
  console.log(`  ✓ ${message}`);
}

/**
 * Google's script, replaced by one that answers the questions this run has.
 *
 * `initialize` records the config on the window — the whole first defect is a field in it —
 * and `renderButton` appends a child, because the component treats an empty slot as "the
 * button never arrived" and would otherwise take the failure branch this run is not testing.
 */
const GIS_STUB = `
window.google = { accounts: { id: {
  initialize(config) { window.__gsiInit = config; },
  renderButton(element) {
    var frame = document.createElement('div');
    frame.setAttribute('data-stub-button', 'true');
    element.appendChild(frame);
  },
} } };
`;

/** What the page handed Google, read back out of the stub. */
async function googleInitConfig(context: BrowserContext): Promise<Record<string, unknown>> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.waitForFunction(() => (window as unknown as { __gsiInit?: unknown }).__gsiInit !== undefined, undefined, {
    timeout: 15_000,
  });
  return page.evaluate(() => (window as unknown as { __gsiInit: Record<string, unknown> }).__gsiInit);
}

/**
 * Waits for a client rewrite to take a parameter out of the address.
 *
 * A boolean rather than a `waitForFunction` that throws, so the failure is reported by the
 * check that owns it — with the address this run actually ended up on — instead of as a
 * timeout thirty lines further down the output.
 */
async function addressDropped(page: Page, name: string): Promise<boolean> {
  try {
    await page.waitForFunction(
      (key) => !new URL(window.location.href).searchParams.has(key),
      name,
      { timeout: 8_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Opens the front door in a context whose Google script is the stub. */
async function door(target: Browser, profile: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
  const context = await target.newContext(profile);
  await context.route('https://accounts.google.com/gsi/client', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: GIS_STUB }),
  );
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  return context;
}

/**
 * Google's own button posts a form, and this is that POST.
 *
 * Deliberately *not* assembled with `fetch`: the whole point is that a browser navigates to
 * the landing carrying a urlencoded body, which is what makes the route's form parsing, its
 * `g_csrf_token` handling and its 303 the things under test. The fake consent page is served
 * under Google's own origin rather than `about:blank`, because an opaque page cannot post a
 * form to an insecure address — and the origin is also closer to the real thing.
 */
async function pressGoogleButton(
  context: BrowserContext,
  credential: string,
  csrf: string,
): Promise<{ url: string }> {
  const page = await context.newPage();
  await page.route('https://accounts.google.com/consent', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <form id="google-form" method="POST" action="${base}${SHOP_PATH}">
          <input type="hidden" name="credential" value="${credential}">
          <input type="hidden" name="g_csrf_token" value="${csrf}">
        </form>
      </body></html>`,
    }),
  );
  await page.goto('https://accounts.google.com/consent');
  await Promise.all([
    page.waitForURL((url) => url.href.startsWith(base), { timeout: 20_000 }),
    page.evaluate(() => (document.getElementById('google-form') as HTMLFormElement).submit()),
  ]);
  await page.waitForLoadState('load').catch(() => undefined);
  return { url: page.url() };
}

/** A desktop that must keep Google's popup: Windows Chrome, no touch screen. */
const DESKTOP = {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 1000 },
};

async function main(): Promise<void> {
  try {
    await resetScratchSchema(source!, schema, true);
    shell('migrate door scratch', 'npx prisma migrate deploy', { ...process.env, DATABASE_URL: scratch });
    if (!skipBuild) {
      shell('production build', 'npm run build');
    } else if (!existsSync('.next/BUILD_ID')) {
      throw new Error('No production build to reuse');
    }

    /*
     * `PUBLIC_BASE_URL` is emptied for the duration, and that is a test-environment fact
     * rather than a preference: the shop's own box has one (its tunnel), and a page that
     * minted `login_uri` from it would name an address this run does not serve and redirect
     * the browser to a host the test cannot reach.
     *
     * Emptied rather than deleted, and that is the subtle half: Next loads `.env` into the
     * server process itself, so a deleted variable comes straight back from the file, while
     * an explicitly empty one is not overridden — and `readPublicBaseUrl` reads empty as
     * "not configured", which is exactly what a direct deployment is. The precedence itself
     * (configured wins over derived) is `public-url.ts`'s, asserted in
     * `tests/public-url.test.ts`.
     *
     * With nothing configured, the landing derives its own address — and on this custom
     * server that derived origin is `http://localhost:<port>`, whatever Host the browser
     * asked for (measured, not assumed: a route handler answers a request carrying
     * `Host: example.test` with a landing on `localhost`). So `base` below is `localhost`
     * too, and that is load-bearing rather than cosmetic: the browser leaves Google and
     * lands on the host **this process names**, the handoff cookie is written for that host,
     * and the phone step that spends it is on it. A run whose base were `127.0.0.1` would
     * set a cookie on one host and look for it on another — the app would be right and the
     * test would fail.
     */
    process.env.PUBLIC_BASE_URL = '';

    // Google, stood up before the app boots: the door reads its client id from the
    // environment at startup, exactly like the LINE channel.
    googleStub = await startGoogleStub(GOOGLE_STUB_CLIENT_ID);
    process.env.GOOGLE_CLIENT_ID = googleStub.clientId;
    process.env.GOOGLE_JWKS_URL = googleStub.jwksUrl;

    const port = await freePort(3381);
    base = `http://localhost:${port}`;
    const started = startServer(scratch, port);
    server = started.child;
    serverLog = started.log;
    await waitForServer(base, server, started.log);

    /*
     * A configured shop, because `/login` sends an unconfigured deployment to `/setup` —
     * and the front door is the screen under test.
     */
    const anonymous = new Session(() => base);
    const shop = await anonymous.request('/api/v1/setup', {
      method: 'POST',
      body: {
        shop: { name: SHOP_NAME, isVatRegistered: true, taxId: '1103700555555', vatRate: 7, receiptPrefix: 'GD' },
        admin: ADMIN,
      },
    });
    check(shop.status === 200, 'the run configures its own shop, so the front door renders');

    phoneBrowser = engine === 'chromium' ? await chromium.launch() : await webkit.launch();
    flowBrowser = engine === 'chromium' ? phoneBrowser : await chromium.launch();
    console.log(
      `\ngoogle door: the door in ${engine}, the landing it leaves behind in chromium, a desktop in ${engine}, and the front door's own words\n`,
    );

    /* 1. What a phone's page hands Google. */
    const phone = await door(phoneBrowser, devices['iPhone 13']);
    const phoneConfig = await googleInitConfig(phone);
    check(
      phoneConfig.ux_mode === 'redirect',
      `an iPhone asks Google for redirect mode (got ${String(phoneConfig.ux_mode)})`,
    );
    check(
      phoneConfig.login_uri === `${base}${SHOP_PATH}`,
      `and names its own landing as login_uri (got ${String(phoneConfig.login_uri)})`,
    );
    check(phoneConfig.client_id === GOOGLE_STUB_CLIENT_ID, 'and carries the configured client id');
    const phonePage = phone.pages()[0]!;
    check(
      (await phonePage.locator('[data-stub-button]').count()) === 1,
      'and the button Google paints into the slot is still there, so the door is not a dead end',
    );
    check(
      (await phonePage.getByText('ขั้นตอนที่ 2 จาก 2').count()) === 0,
      'and the phone step is not showing yet: nothing has come back from Google',
    );

    /* 2. The promise that a desktop was not moved off Google's preferred shape. */
    const desktop = await door(phoneBrowser, DESKTOP);
    const desktopConfig = await googleInitConfig(desktop);
    check(
      desktopConfig.ux_mode === undefined && desktopConfig.login_uri === undefined,
      'a desktop keeps Google default (popup): neither ux_mode nor login_uri is sent',
    );

    /*
     * 3. Google's own button posts a form, from Google's own page. This is that POST, made
     *    by a page that is not ours — which is also why it is the honest way to prove the
     *    landing: a request this script assembled with `fetch` would skip the browser.
     */
    const firstSubject = 'google-door-phone';
    const arrival = await pressGoogleButton(
      phone,
      await googleStub.mintIdToken(firstSubject, { fullName: 'ลูกค้าใหม่ จากกูเกิล' }),
      'csrf-value-from-the-browser',
    );
    check(
      arrival.url === `${base}/login?google=new`,
      `the landing hands the browser back to the phone step (landed on ${arrival.url.replace(base, '')})`,
    );
    const phoneCookies = await phone.cookies(base);
    const handoff = phoneCookies.find((cookie) => cookie.name === GOOGLE_PENDING_COOKIE);
    check(
      handoff !== undefined && handoff.httpOnly === true,
      `and leaves the Google proof in an httpOnly cookie, not in a session (found ${
        handoff ? `httpOnly=${handoff.httpOnly}` : 'no cookie'
      })`,
    );
    /*
     * `Secure`, because this run serves the production build and the route mirrors
     * `NODE_ENV`. A browser storing a Secure cookie for `http://localhost` is not a
     * contradiction: loopback is a secure context, which is what makes a plain-http run of
     * a production build possible at all.
     */
    check(handoff?.secure === true, 'and marks it Secure, the way a production build does');
    check(
      phoneCookies.every((cookie) => cookie.name !== 'pos_session'),
      'and signs nobody in: the redirect landing for an unknown account mints no session',
    );
    const phoneStep = phone.pages()[phone.pages().length - 1]!;
    check(
      (await phoneStep.getByText('ขั้นตอนที่ 2 จาก 2').count()) === 1,
      'and the phone step is on screen in the first paint of the page it landed on',
    );

    /*
     * 4. The same arrival, in the engine that can carry its consequence.
     *
     *    Everything above proved the landing *in the phone engine*: the 303, the handoff
     *    cookie, the absence of a session, the phone step in the first paint. What is left
     *    is what the handoff is *for* — a first sign-in finishing without an id token in the
     *    browser — and that needs the cookie to come **back**, which WebKit will not do over
     *    plain http for a `Secure` cookie (see `flowBrowser`). So the arrival is made again
     *    in Chromium on the same profile, with the same Google subject: the door treats it
     *    identically, because nothing about it knows or cares which engine asked.
     *
     *    The completion is still driven **from inside the page**: a request this script
     *    assembled with its own `fetch` would carry a cookie the script chose rather than the
     *    one the browser stored, which is the whole thing under test. The door's own rules
     *    about the number live on the server (`identity.ts`), and acceptance section 16
     *    drives those over HTTP.
     */
    const flow = await door(flowBrowser, devices['iPhone 13']);
    const flowPage = flow.pages()[0]!;
    const flowArrival = await pressGoogleButton(
      flow,
      await googleStub.mintIdToken(firstSubject, { fullName: 'ลูกค้าใหม่ จากกูเกิล' }),
      'csrf-from-the-flow-browser',
    );
    check(
      flowArrival.url === `${base}/login?google=new`,
      'the same arrival in chromium lands on the phone step too',
    );
    check(
      (await flow.cookies(base)).some((cookie) => cookie.name === GOOGLE_PENDING_COOKIE),
      'with the handoff cookie the landing set still in the jar',
    );

    const completion = await flowPage.evaluate(
      async (noticeVersion) => {
        const response = await fetch('/api/v1/auth/signup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phone: '0863330001', noticeVersion }),
        });
        return {
          status: response.status,
          body: (await response.json()) as {
            data?: { created?: boolean };
            error?: { code?: string; message?: string };
          },
        };
      },
      CURRENT_CUSTOMER_NOTICE_VERSION,
    );
    /*
     * The body is printed on failure, not just the status. Every refusal this route can
     * give is a 4xx, and "422" alone cannot tell a spent handoff (`GOOGLE_PENDING_EXPIRED`)
     * from a phone number the door rejected (`NOTICE_NOT_ACKNOWLEDGED`, `PHONE_…`) — which
     * is the difference between a stale cookie and a rule doing its job.
     */
    check(
      completion.status === 200 && completion.body.data?.created === true,
      `the phone step completes from the handoff alone (status ${completion.status}${
        completion.body.error ? `, ${completion.body.error.code}` : ''
      })`,
    );
    const afterSignup = await flow.cookies(base);
    check(
      afterSignup.some((cookie) => cookie.name === 'pos_session') &&
        afterSignup.every((cookie) => cookie.name !== GOOGLE_PENDING_COOKIE),
      'and the handoff is spent, replaced by a session',
    );

    const shopPage = await flowPage.goto(`${base}/shop/products`);
    check(
      shopPage !== null && shopPage.status() < 400 && flowPage.url().startsWith(`${base}/shop/products`),
      'and the shop own screen renders for that customer, signed in by that cookie',
    );

    /* 5. The same account a second time: the row exists, so nothing is asked for. */
    const returning = await door(flowBrowser, devices['iPhone 13']);
    const returningPage = returning.pages()[0]!;
    const knownArrival = await pressGoogleButton(
      returning,
      await googleStub.mintIdToken(firstSubject),
      'another-csrf-value',
    );
    check(
      knownArrival.url === `${base}/shop/products`,
      `and a second landing for the same account signs straight in (landed on ${knownArrival.url.replace(base, '')})`,
    );
    check(
      (await returning.cookies(base)).some((cookie) => cookie.name === 'pos_session'),
      'with a session minted by the landing itself',
    );
    const returningShop = await returningPage.goto(`${base}/shop/products`);
    check(
      returningShop !== null && returningShop.status() < 400,
      'and that browser can open the shop without being sent back to the front door',
    );

    /*
     * 6. The front door's arrival words, and where they live after they have been read.
     *
     *    This is the shop's latest report in two halves, both of them invisible to every
     *    other gate: a *notice* left in the query string is re-read by every re-open (the back
     *    button, a bookmark, a link pasted into a chat, the operator checking the page
     *    answers) and each of those reads a failure that is over, while the callback's own
     *    address opened with nothing on it used to answer `?line=error` — so the person
     *    checking that the callback answered was told their sign-in had failed. Both are one
     *    rule for the two doors, and the rule only exists once the page's JavaScript runs.
     */
    const words = phone.pages()[0]!;

    await words.goto(`${base}/login?line=error`);
    check(
      (await words.getByText('เข้าสู่ระบบด้วย LINE ไม่สำเร็จ').count()) === 1,
      'a LINE failure word is on screen from the first paint',
    );
    check(
      (await addressDropped(words, 'line')) && (await words.getByText('เข้าสู่ระบบด้วย LINE ไม่สำเร็จ').count()) === 1,
      `and the address lets go of it without taking the sentence off the screen (left on ${words.url().replace(base, '')})`,
    );

    await words.goto(`${base}/login?google=error`);
    check(
      (await words.getByText('เข้าสู่ระบบด้วย Google ไม่สำเร็จ').count()) === 1 &&
        (await addressDropped(words, 'google')),
      'the Google door’s failure word behaves the same way',
    );

    await words.goto(`${base}/login?line=claim`);
    check(
      new URL(words.url()).searchParams.get('line') === 'claim' &&
        (await words.getByText('ยืนยันเบอร์มือถือ').count()) === 1,
      'but a step keeps its address, so a reload lands back in the step rather than at the button',
    );

    /*
     * The reported half: the callback address, opened by somebody checking it answers. It is
     * not an arrival, so the front door has nothing to say — no `?line=` code and no sentence
     * about a sign-in nobody began.
     */
    const bareCallback = await words.goto(`${base}/api/v1/auth/line/callback`);
    check(
      bareCallback !== null &&
        words.url() === `${base}/login` &&
        (await words.getByText('ไม่สำเร็จ').count()) === 0,
      `the callback opened with nothing on it says nothing at all (landed on ${words.url().replace(base, '')})`,
    );

    console.log(`\ngoogle door: ${checks} checks, all passed (door in ${engine}, flow in chromium)\n`);
  } catch (error) {
    console.error(`\ngoogle door could not complete:\n${error instanceof Error ? error.stack : error}`);
    /*
     * The server's last words, because the failures this run is about are *its* — a refusal
     * the route logs with the stage it died at, or a warning from the signup path. Only the
     * tail is printed: a Next server's startup output is a route list and a build banner.
     */
    if (serverLog !== null) {
      const said = serverLog().trim().split('\n').slice(-15).join('\n');
      console.error(`\nlast thing the server said:\n${said}`);
    }
    process.exitCode = 1;
  } finally {
    if (phoneBrowser !== null) {
      await phoneBrowser.close();
    }
    // Not the same object when `--engine=chromium`, and closing it twice is a no-op rather
    // than a mistake: Playwright's `close` is idempotent, and one branch is cheaper than a
    // condition nobody would remember to keep in step.
    if (flowBrowser !== null) {
      await flowBrowser.close();
    }
    if (googleStub !== null) {
      await googleStub.close();
    }
    if (server !== null) {
      await stopServer(server);
    }
    if (!keep) {
      await resetScratchSchema(source!, schema, false).catch(() => undefined);
    }
  }
}

void main();
