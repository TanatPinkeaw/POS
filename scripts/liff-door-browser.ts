/**
 * `npm run liff:door` — the in-LINE entry in a real browser (ADR 0032 §1).
 *
 * The one thing ADR 0032 could not prove is the part of `/line` that only exists once a
 * browser has run it: the page imports LINE's SDK, initialises it, reads `isInClient()` and a
 * token, and posts that token to the door that already exists. Every other gate here reads
 * HTML or calls the API, and `tests/line-liff-entry.test.ts` pins the *decision* — but none of
 * them can see whether the component wires that decision to the SDK correctly, because the
 * SDK is a browser-only module whose handshake happens inside LINE's app. That is the gap this
 * run closes: it replaces **the SDK's own chunk** with a stand-in that answers like LINE does,
 * and then measures what the page does with each answer.
 *
 * Six answers, each a different screen, and every one of them is a stage the entry claims to
 * have:
 *
 *   1. **In LINE, an account nobody holds** — the phone step renders *in this page* (the
 *      decision ADR 0032 §1 makes: the id token exists in this browser only, so a customer
 *      thrown out to a web form is where a first sign-in dies), no session is minted, and the
 *      token is not put in storage.
 *   2. **The first sign-in finishes here** — a number, a code from the shop's own OTP gateway,
 *      the notice read to its end and ticked, and the customer is signed in with the phone
 *      they proved. This is the whole promise of the entry, walked in a browser.
 *   3. **In LINE, an account already bound** — the same LINE account in a fresh browser is
 *      signed in with no phone step at all, which is what "one tap" means.
 *   4. **A token minted for a different channel** — refused, which is what makes the two sign-ins
 *      above mean something: the key set is one this process serves, so an entry that accepted
 *      anything carrying a signature would pass every other check here.
 *   5. **Outside LINE** — the link was opened somewhere it was not meant to be opened, and the
 *      entry says so and offers the ordinary doors rather than asking LINE to log somebody in
 *      inside a browser that is not LINE (`liff.login()` is not called, and the token is never
 *      asked for).
 *   6. **LINE's SDK will not load, and the shop has not configured an entry at all** — the two
 *      sentences a customer can actually act on, in a browser where the words are painted.
 *
 * **What replaces the SDK, and why that is honest rather than a cheat.** `@line/liff` ships as
 * its own chunk, because the component imports it dynamically; this run finds that chunk in the
 * build, asserts it found **exactly one** (a silent zero would make every check below pass for
 * the wrong reason), and serves a stand-in in its place through the browser's own request
 * interception. So what `import('@line/liff')` resolves to is replaced — the component, the
 * page, the routes, the session, the OTP and the id-token verification are all the real ones,
 * and the token the page hands the server is a real ES256 token signed by a key this run
 * generated and serves as a JWKS (`line-liff-stub.ts`). What cannot be measured here is LINE's
 * own app handoff — no browser in this repository is LINE — and that is the sentence ADR 0032
 * keeps; everything on this side of it is now a check rather than a promise.
 *
 * Usage:
 *   npm run liff:door                    build (or reuse), serve the scratch schema, drive it
 *   npm run liff:door -- --skip-build    reuse the existing `.next` build
 *   npm run liff:door -- --engine=webkit on a machine without Chromium installed
 *   npm run liff:door -- --keep          leave the scratch schema to inspect
 *
 * Needs `TEST_DATABASE_URL` naming a test database, and `npx playwright install chromium`.
 */
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { basename, join, relative, sep } from 'node:path';

import {
  chromium,
  webkit,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

import { LIFF_ENTRY_PATH, LIFF_SIGN_IN_ENDPOINT } from '../src/lib/line-liff-entry';

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
import { LINE_STUB_CHANNEL_ID, LINE_STUB_LIFF_ID, startLineStub, type LineStub } from './line-liff-stub';

loadEnv();

const schema = 'liffdoor';
const source = process.env.TEST_DATABASE_URL;
if (!source || !new URL(source).pathname.toLowerCase().includes('test')) {
  throw new Error('liff:door requires TEST_DATABASE_URL naming a test database');
}
const scratch = scratchUrl(source, schema);
const skipBuild = process.argv.includes('--skip-build');
const keep = process.argv.includes('--keep');
/*
 * Chromium by default, and that is a measurement rather than a preference — the one
 * `google:door` recorded first: this run serves a **production build over plain http**, so the
 * session cookie is `Secure`, and WebKit stores such a cookie for `http://localhost` and then
 * never sends it back over it. Every check below that ends signed in needs the cookie to come
 * back, so the default engine is the one that sends it over loopback. `--engine=webkit` is there
 * for a machine without Chromium, and it is honest about what it can then prove.
 */
const engine = process.argv.find((arg) => arg.startsWith('--engine='))?.slice(9) ?? 'chromium';

const ADMIN = { fullName: 'ผู้ดูแล LINE', phone: '0800000700', password: 'liff-door-admin-1' };
const SHOP_NAME = 'ร้านทดสอบ LIFF';
/** A number nobody holds, so the first sign-in through the entry creates the customer. */
const NEW_PHONE = '0865550001';
/**
 * The LINE account the first sign-in binds, and case 3 comes back as: one subject in two fresh
 * browsers is what "one tap for an account that already has a customer" means — a *second*
 * subject would be another first sign-in and would prove nothing about the binding.
 */
const LINE_SUBJECT = 'liff-door-first';

let server: ChildProcess | null = null;
/** The second server, with no LIFF app id — the shop that has not set the entry up. */
let bareServer: ChildProcess | null = null;
let browser: Browser | null = null;
let lineStub: LineStub | null = null;
let otpGateway: Server | null = null;
/** What the shop's OTP gateway was handed, which is where this run reads its codes. */
const otpInbox: { to: string; code: string }[] = [];
let serverLog: (() => string) | null = null;
let base = '';
let checks = 0;
/** The file name of the chunk the stand-in replaces, for the diagnosis below. */
let sdkChunkName = '';
/** Console, page and network failures per page: a check that fails has to say what broke. */
const pageLogs = new Map<Page, string[]>();

function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
  checks += 1;
  console.log(`  ✓ ${message}`);
}

/**
 * Wait for a control to reach a state, rather than reading it once.
 *
 * **`locator.isEnabled()` answers *now*.** Its `timeout` is how long to wait for the element to
 * exist, not for the property to change — which is a difference that shows up only as a flaky
 * gate, and did: the notice check below passed on one run and failed the next, because the
 * `scroll` event an assignment to `scrollTop` dispatches is queued rather than synchronous and
 * React had not re-rendered when the first read happened. The state being read here is the whole
 * point of the gate, so this polls instead of trusting one read.
 */
async function waitForEnabled(locator: Locator, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await locator.isEnabled()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await locator.page().waitForTimeout(100);
  }
}

/**
 * The stand-in for `@line/liff` and the shape it has to be written in — served in place of the
 * SDK's own chunk.
 *
 * It answers exactly what the component asks — `init`, `isInClient`, `getIDToken` — and reads its
 * answers from `window.__liffStub`, which each context seeds before any page script runs. Every
 * call is recorded on `window.__liffCalls`, so the run can assert *what the page asked LINE for*
 * rather than only what ended up on screen: that is the half a screenshot cannot show, and it is
 * how "the entry passed it the configured app id" becomes a check.
 *
 * **Why this is a chunk and not a module, measured.** The first version of this file served an ES
 * module — `export default { … }` — and the browser answered `Unexpected token 'export'`, with the
 * page stuck on "กำลังยืนยันบัญชี LINE…" forever. That is what this build's chunk format is: the
 * dynamic `import('@line/liff')` compiles to `e.l('static/chunks/…').then(() => t(2517))` in the
 * page's own chunk, so what the loader evaluates is not a module at all but **a Turbopack chunk
 * that registers module ids** — the same `push([currentScript, id, factory, …])` list every other
 * chunk in `.next/static/chunks` is written in. So the stand-in is written in that format, with
 * the id and the export map *read out of the real chunk* rather than guessed.
 *
 * Reading them is the whole reason this is a function: a hard-coded `2517` would work today and
 * silently test nothing after the next build, and a stand-in that fails to register would leave
 * the page spinning exactly as a broken entry does — the failure this gate exists to catch. So the
 * id comes from the export registration LINE's own chunk performs, and the run refuses to proceed
 * when either half is missing (`liffStubSource`).
 */
interface LiffModuleShape {
  /** The Turbopack module id the page's `import('@line/liff')` resolves through. */
  moduleId: string;
  /** The chunk format itself, with a placeholder where the module factory goes. */
  template: string;
}

/**
 * Reads the shape of the real chunk: which module id the page will require, and its own preamble.
 *
 * Two facts, both taken from the artefact under test rather than from documentation: the id named
 * in the default-export registration (`e.s(["default",0,value],<id>)`), and the chunk preamble the
 * build uses to announce itself. The preamble is lifted verbatim so this file cannot drift from
 * whatever the bundler writes — if it ever changes, this run fails at `liffStubSource` instead of
 * serving a chunk no browser can evaluate.
 */
function readLiffModuleShape(chunkBody: string): LiffModuleShape {
  const registered = /e\.s\(\[[^\]]*"default"[^\]]*\],\s*(\d+)\s*\)/.exec(chunkBody);
  const preamble = /^(\(globalThis\.TURBOPACK\|\|?\(globalThis\.TURBOPACK=\[\]\)\)\.push\(\[)/.exec(
    chunkBody,
  );
  if (registered === null || preamble === null) {
    throw new Error(
      'The LIFF chunk no longer registers a default export the way this run reads it ' +
        `(registration ${registered === null ? 'missing' : 'found'}, preamble ${
          preamble === null ? 'missing' : 'found'
        }). Re-read .next/static/chunks for the new shape rather than trusting this file.`,
    );
  }
  const moduleId = registered[1]!;
  if (!new RegExp(`[,\\[]${moduleId},e=>\\{`).test(chunkBody)) {
    throw new Error(
      `The LIFF chunk registers module ${moduleId} without a factory this run can replace.`,
    );
  }
  return { moduleId, template: `${preamble[1]}"object"==typeof document?document.currentScript:void 0,` };
}

/**
 * The chunk this run serves in the LIFF module's place, in the build's own format.
 *
 * `e.s(defs, id)` is the call LINE's own module ends with, so the stand-in ends with it too: the
 * page requires the module by id and gets a `default` that answers `init`, `isInClient` and
 * `getIDToken`. `window.__liffCalls` is emptied here as well as in the context script, because the
 * module can be evaluated after a reload of the same page.
 */
function liffStubSource(shape: LiffModuleShape): string {
  const object =
    '{init:function(o){calls.push({method:"init",liffId:o&&o.liffId});' +
    'return config().failInit?Promise.reject(new Error("stub: liff init failed")):Promise.resolve()},' +
    'isInClient:function(){calls.push({method:"isInClient"});return config().inClient===true},' +
    'getIDToken:function(){calls.push({method:"getIDToken"});' +
    'var t=config().token;return t===undefined?null:t}}';
  return (
    `${shape.template}${shape.moduleId},e=>{` +
    'window.__liffStub=window.__liffStub||{};window.__liffCalls=[];' +
    'var config=function(){return window.__liffStub};var calls=window.__liffCalls;' +
    `e.s(["default",0,${object}],${shape.moduleId})}` +
    ']);'
  );
}

/**
 * The chunk that carries LINE's SDK, found in the build rather than hard-coded.
 *
 * A hash-named file is the one thing a gate may not hard-code, and a *wrong* file would be
 * worse than none: replacing some other chunk would break the page for a reason that reads like
 * a gate bug. So the chunk is identified by two strings only the SDK has — its own error
 * constant and the method the entry calls — and the run asserts it matched **exactly one** file,
 * so an SDK release that renames either fails loudly here instead of silently testing nothing.
 */
function findLiffSdkChunk(): string[] {
  const root = join('.next', 'static', 'chunks');
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) {
        continue;
      }
      const body = readFileSync(full, 'utf8');
      if (body.includes('getIDToken') && body.includes('INIT_FAILED')) {
        hits.push(full);
      }
    }
  };
  if (existsSync(root)) {
    walk(root);
  }
  return hits;
}

/** A context whose SDK is the stand-in, with the answers this case is about. */
async function liffContext(
  target: Browser,
  stub: { inClient: boolean; token?: string | null; failInit?: boolean },
  /** The chunk this run replaces, and the shape the stand-in must be written in. */
  standIn: { chunk: string; shape: LiffModuleShape },
): Promise<BrowserContext> {
  /*
   * A phone, because that is what a LIFF app is opened on — and because the notice gate below
   * needs the privacy notice to be *taller than its box*. A desktop-sized viewport can fit the
   * whole notice inside it, and then the tick is enabled from the first paint, which would make
   * "the notice must be read before it can be ticked" pass without the box ever being scrolled.
   */
  const context = await target.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((answers) => {
    (window as unknown as { __liffStub: unknown }).__liffStub = answers;
  }, stub);
  /*
   * The chunk, matched by suffix rather than by an absolute path: what the browser asks for is
   * `/_next/static/chunks/…`, but the prefix is Next's business and only the file name is this
   * run's. A predicate that hard-coded the prefix would silently stop matching — and every check
   * below would pass against the *real* SDK, which cannot work in a browser that is not LINE.
   */
  const chunkSuffix = `/${relative(join('.next', 'static'), standIn.chunk).split(sep).join('/')}`;
  /*
   * The one request this run rewrites: the chunk the page's own `import('@line/liff')` asks for.
   * It is served as the build serves it — a classic script that registers a module id — because
   * that is what the Turbopack loader evaluates; an ES module here is a parse error and the page
   * never leaves "กำลังยืนยันบัญชี LINE…".
   */
  await context.route(
    (url) => url.pathname.endsWith(chunkSuffix),
    (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: liffStubSource(standIn.shape),
      }),
  );
  return context;
}

/**
 * Opens the entry in a context built for one case, recording what the browser complains about.
 *
 * Every failure this gate can have is *client-side*: a chunk that did not load, an SDK answer the
 * component mishandled, a route that refused the token. Nothing about it reaches the server's log,
 * so the page's own console is the only place the reason exists and a check that fails without it
 * reads like the entry being broken rather than like a diagnosis.
 */
async function openEntry(
  context: BrowserContext,
  url = `${base}${LIFF_ENTRY_PATH}`,
): Promise<{ page: Page; context: BrowserContext }> {
  const page = await context.newPage();
  const lines: string[] = [];
  pageLogs.set(page, lines);
  page.on('console', (message) => {
    if (message.type() === 'error') {
      lines.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => lines.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) =>
    lines.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`),
  );
  await page.goto(url);
  return { page, context };
}

/**
 * What the page showed, what it asked LINE, and whether the stand-in was ever requested.
 *
 * Called on the way out of a failed check, because "the phone step did not appear" has half a
 * dozen causes and only one of them is the entry being wrong: the chunk may not have been
 * intercepted, the SDK may have answered without a token, or the sign-in route may have refused
 * what a real ES256 token should have satisfied.
 */
async function diagnose(page: Page): Promise<void> {
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim().slice(0, 400);
  const asked = JSON.stringify(await liffCalls(page));
  const requested = await page.evaluate(
    (name) =>
      performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.includes(name))
        .length,
    sdkChunkName,
  );
  console.log(`  · page said: ${text}`);
  console.log(`  · asked LINE: ${asked}`);
  console.log(
    `  · the SDK chunk ${sdkChunkName} was ${requested > 0 ? 'requested' : 'NEVER requested'}`,
  );
  for (const line of pageLogs.get(page) ?? []) {
    console.log(`  · ${line}`);
  }
}

/** The stub's own record of what the page asked LINE, read back out of the browser. */
async function liffCalls(page: Page): Promise<{ method: string; liffId?: string }[]> {
  return page.evaluate(
    () => (window as unknown as { __liffCalls?: { method: string; liffId?: string }[] }).__liffCalls ?? [],
  );
}

/**
 * Everything a browser stored for this origin, so "the token is not persisted" can be checked.
 *
 * Written without a named inner function on purpose: this file runs through `tsx`, whose
 * keep-names transform wraps a named function in a `__name(…)` helper — and Playwright sends the
 * function's *source* to the page, where that helper does not exist. The error reads
 * `__name is not defined`, which looks like a bug in the stand-in rather than in this line.
 */
async function storedText(page: Page): Promise<string> {
  return page.evaluate(() =>
    [window.localStorage, window.sessionStorage]
      .flatMap((storage) => {
        const pairs: string[] = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) ?? '';
          pairs.push(`${key}=${storage.getItem(key) ?? ''}`);
        }
        return pairs;
      })
      .join('\n'),
  );
}

/** Waits for a client-side arrival at a path, without throwing on its own. */
async function waitForPath(page: Page, predicate: (path: string) => boolean, timeout = 20_000): Promise<boolean> {
  try {
    await page.waitForURL((url) => predicate(url.pathname), { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * A shop that has already turned the entry on, plus the LINE this run stands in for.
 *
 * Each is a listener this process serves and each is configured through the environment the
 * same way the shop's own `.env` would: the LINE Login channel id is what an id token's
 * audience must be, `LINE_JWKS_URL` is where the ES256 key set is fetched, and the OTP gateway
 * is the shop's own `OTP_WEBHOOK_URL` — which is how this run reads the code a real customer
 * would read off their phone.
 */
async function main(): Promise<void> {
  try {
    await resetScratchSchema(source!, schema, true);
    shell('migrate door scratch', 'npx prisma migrate deploy', { ...process.env, DATABASE_URL: scratch });
    if (!skipBuild) {
      shell('production build', 'npm run build');
    } else if (!existsSync('.next/BUILD_ID')) {
      throw new Error('No production build to reuse');
    }

    const sdkChunks = findLiffSdkChunk();
    check(
      sdkChunks.length === 1,
      `exactly one chunk in the build carries LINE's SDK (found ${sdkChunks.length})`,
    );
    const sdkChunk = sdkChunks[0]!;
    sdkChunkName = basename(sdkChunk);
    const standIn = { chunk: sdkChunk, shape: readLiffModuleShape(readFileSync(sdkChunk, 'utf8')) };
    check(
      /^\d+$/.test(standIn.shape.moduleId),
      `and names the module id the page's import resolves through (${standIn.shape.moduleId}), which this run answers in its place`,
    );

    /*
     * Empty rather than unset, for the reason `google:door` records: Next loads `.env` into the
     * server process, so a deleted variable comes straight back from the file while an explicit
     * empty one is not overridden. This run serves `localhost` either way.
     */
    process.env.PUBLIC_BASE_URL = '';

    lineStub = await startLineStub(LINE_STUB_CHANNEL_ID);
    process.env.LINE_LOGIN_CHANNEL_ID = lineStub.channelId;
    process.env.LINE_LOGIN_CHANNEL_SECRET = 'liff-door-channel-secret';
    process.env.LINE_JWKS_URL = lineStub.jwksUrl;
    process.env.LINE_LIFF_ID = LINE_STUB_LIFF_ID;

    const otpPort = await freePort(3471);
    otpGateway = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        try {
          const body = JSON.parse(raw) as { to?: unknown; code?: unknown };
          otpInbox.push({ to: String(body.to ?? ''), code: String(body.code ?? '') });
        } catch {
          // A body this run cannot read is not a code; the check that owns the code says so.
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => otpGateway!.listen(otpPort, '127.0.0.1', resolve));
    process.env.OTP_CHANNEL = 'webhook';
    process.env.OTP_WEBHOOK_URL = `http://127.0.0.1:${otpPort}/otp`;

    const port = await freePort(3391);
    base = `http://localhost:${port}`;
    const started = startServer(scratch, port);
    server = started.child;
    serverLog = started.log;
    await waitForServer(base, server, started.log);

    const anonymous = new Session(() => base);
    const shop = await anonymous.request('/api/v1/setup', {
      method: 'POST',
      body: {
        shop: {
          name: SHOP_NAME,
          isVatRegistered: true,
          taxId: '1103700777777',
          vatRate: 7,
          receiptPrefix: 'LD',
        },
        admin: ADMIN,
      },
    });
    check(shop.status === 200, 'the run configures its own shop, so the entry renders');

    browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch();
    console.log(`\nliff door: the in-LINE entry in ${engine}, with LINE's SDK replaced by a stand-in\n`);

    /* 1. In LINE, an account nobody holds: the phone step, in this page. */
    const firstToken = await lineStub.mintIdToken(LINE_SUBJECT, { displayName: 'ลูกค้า คนแรก' });
    const firstContext = await liffContext(browser, { inClient: true, token: firstToken }, standIn);
    const first = await openEntry(firstContext);
    const claimShown = await first.page
      .locator('#linePhone')
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!claimShown) {
      await diagnose(first.page);
    }
    check(claimShown, 'an unknown LINE account gets the phone step, inside the entry');
    check(
      new URL(first.page.url()).pathname === LIFF_ENTRY_PATH,
      `and is not thrown out to the front door (still on ${new URL(first.page.url()).pathname})`,
    );
    check(
      (await firstContext.cookies(base)).every((cookie) => cookie.name !== 'pos_session'),
      'and no session is minted for an account that has proved no number',
    );

    /*
     * `__liffCalls` only exists because this run's stand-in was the module that loaded, so a
     * non-empty list is the proof that the *stand-in* answered — the check that keeps every
     * sentence below from passing against LINE's real SDK in a browser that is not LINE.
     */
    const asked = await liffCalls(first.page);
    check(
      asked.length > 0,
      'LINE\'s own chunk was replaced by this run\'s stand-in, and the page called it',
    );
    check(
      asked[0]?.method === 'init' && asked[0]?.liffId === LINE_STUB_LIFF_ID,
      `the page initialises LINE with the app id this deployment is configured with (got ${String(asked[0]?.liffId)})`,
    );
    check(
      asked.some((call) => call.method === 'getIDToken'),
      'and asks LINE for an id token rather than reading one from the address',
    );
    check(
      !(await storedText(first.page)).includes(firstToken.slice(0, 40)),
      'and does not persist that token anywhere a later page could read it',
    );
    check(
      (await first.page.locator('#linePromoOptIn').isChecked()) === false,
      'and the second consent is offered unticked, so binding never becomes agreement to promotions',
    );

    /* The notice gate the step inherits: no tick before the text has been read to its end. */
    const tick = first.page.locator('label', { hasText: 'ยืนยันว่าคุณได้อ่านนโยบาย' }).locator('input');
    check(
      await tick.isDisabled(),
      'and the notice cannot be ticked before it has been read to the end',
    );
    /*
     * The notice is read in the design system's popup, so the walk opens it the way a customer
     * does: the panel's own button. The reading area is then located by its own first sentence
     * rather than as "the first tabbable div", so a second scrollable region appearing on this
     * screen cannot quietly become the thing this run scrolled — the check would then fail for a
     * reason that reads like the notice gate broke.
     *
     * **The scroll is an assignment to `scrollTop`, and that is three measurements rather than a
     * preference.** This was tried the way a person scrolls first, and neither works *here*:
     * measured on this build, `mouse.wheel` over the box moves it to its own end (`scrollTop` 910
     * of 910) and `End` on the focused box moves it 50px, and **neither produces the `scroll`
     * event the page's `onScroll` runs on** — the tick stays locked for seconds after both. The
     * assignment does produce it, and the event React handles is the same one either way, so what
     * is being checked is the gate the app owns: a scroll that has reached the end unlocks the
     * tick, and a box that has not been scrolled does not. What this cannot reproduce is a thumb —
     * Playwright drives a wheel and a keyboard, not a touch — and that is the honest limit of this
     * check rather than a gap in the notice.
     */
    /*
     * The popup is opened and closed by the panel's own two controls, and the reading area is
     * found the same way both times it is measured below. `footer` disambiguates the close: the
     * header carries an icon button whose accessible name is also "ปิด", and a strict locator that
     * matched both would fail for a reason that has nothing to do with the notice.
     */
    const openNotice = (): Promise<void> =>
      first.page.getByRole('button', { name: 'อ่านนโยบายคุ้มครองข้อมูลส่วนบุคคล' }).click();
    const closeNotice = (): Promise<void> =>
      first.page.locator('footer').getByRole('button', { name: 'ปิด' }).click();
    const readingArea = () =>
      first.page
        .locator('div[tabindex="0"]')
        .filter({ hasText: 'ร้านเก็บชื่อ–นามสกุล' })
        .first();
    const measure = (): Promise<{
      scrollTop: number;
      clientHeight: number;
      scrollHeight: number;
      overflowY: string;
    }> =>
      readingArea().evaluate((element) => ({
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));

    await openNotice();
    const noticeBox = readingArea();
    await noticeBox.waitFor({ state: 'visible', timeout: 10_000 });
    /*
     * **The gate is only a gate if the notice is taller than the area it is read in.** This is
     * the measurement the popup's `max-height` is chosen against, asserted rather than eyeballed:
     * a notice that fits would leave `hasReachedNoticeEnd` answering "true" from the first paint,
     * and every check below would pass on a tick that was never earned. The margin is one line of
     * Thai rather than the smallest number that works, so a re-wrapped paragraph does not quietly
     * turn this into a formality.
     */
    const metrics = await measure();
    console.log(`  · the reading area before it is scrolled: ${JSON.stringify(metrics)}`);
    check(
      metrics.scrollHeight > metrics.clientHeight + 100,
      'and the notice is taller than the popup it is read in, so the gate is not a formality',
    );
    await noticeBox.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const reachedEnd = await waitForEnabled(tick);
    if (!reachedEnd) {
      const box = await noticeBox.evaluate((element) => ({
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      console.log(`  · the notice box after being scrolled to its end: ${JSON.stringify(box)}`);
      console.log(`  · tabbable divs on the page: ${await first.page.locator('div[tabindex="0"]').count()}`);
      await diagnose(first.page);
    }
    check(reachedEnd, 'and reaching its end enables the tick');

    /* Closed the way a customer closes it, before the tick is tapped: the popup covers the form. */
    await closeNotice();
    await first.page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10_000 });

    /*
     * **The same invariant at the width the customer is not usually on, and it is the one that
     * goes wrong on a desk.** The popup's reading area is capped in `rem` and its column in `rem`
     * because a notice that fits inside the area opens the gate at the first paint — and a wider
     * dialog wraps the same seven paragraphs into fewer lines, which is precisely how a cap that
     * is honest on a phone becomes a formality on a laptop. Measured by resizing the page that is
     * already sitting on the step, so this is the same render and the same text, one viewport
     * later, rather than a second walk through LINE's screens.
     */
    await first.page.setViewportSize({ width: 1280, height: 800 });
    await openNotice();
    await noticeBox.waitFor({ state: 'visible', timeout: 10_000 });
    const deskMetrics = await measure();
    console.log(`  · the reading area on a desk: ${JSON.stringify(deskMetrics)}`);
    check(
      deskMetrics.scrollHeight > deskMetrics.clientHeight + 100,
      'and the notice is still taller than the popup when the dialog is at its widest',
    );
    await closeNotice();
    await first.page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10_000 });
    await first.page.setViewportSize({ width: 390, height: 844 });

    /* 2. The first sign-in finishes in this page, with a code the shop's gateway sent. */
    await first.page.locator('#linePhone').fill(NEW_PHONE);
    await first.page.getByRole('button', { name: 'ส่งรหัสไปที่เบอร์นี้' }).click();
    await first.page.locator('#linePhoneCode').waitFor({ state: 'visible', timeout: 20_000 });
    let code = '';
    for (let attempt = 0; attempt < 40 && code === ''; attempt += 1) {
      /*
       * Matched on the last nine digits because the gateway is handed whatever the customer typed
       * and may be handed a country code: `0865550001` and `+66865550001` are one number, which is
       * the same normalisation `src/lib/phone.ts` does for the shop's own lookups.
       */
      code =
        otpInbox.find((entry) => entry.to.replace(/\D/g, '').endsWith(NEW_PHONE.slice(1)))?.code ?? '';
      if (code === '') {
        await first.page.waitForTimeout(250);
      }
    }
    check(code !== '', 'the number is proved by a code the shop itself sent, not by a typed value');
    await tick.check();
    await first.page.locator('#linePhoneCode').fill(code);
    await Promise.all([
      first.page.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }).click(),
      first.page.waitForURL((url) => !url.pathname.startsWith(LIFF_ENTRY_PATH), { timeout: 25_000 }),
    ]);
    const afterClaim = await first.page.evaluate(async () => {
      const response = await fetch('/api/v1/auth/me');
      return { status: response.status, body: (await response.json()) as { data?: { phone?: string; role?: string } } };
    });
    check(
      afterClaim.status === 200 && afterClaim.body.data?.phone === NEW_PHONE,
      `and the sign-in finishes with the phone that was proved (status ${afterClaim.status})`,
    );
    check(
      first.page.url().startsWith(`${base}/shop/products`),
      `and the customer lands on the shop's own catalogue (${first.page.url().replace(base, '')})`,
    );
    check(
      (await firstContext.cookies(base)).some((cookie) => cookie.name === 'pos_session'),
      'carrying a session the rest of the app accepts',
    );
    check(
      (await first.page.locator('body').innerText()).includes('สินค้า'),
      'and the catalogue actually renders for them',
    );

    /* 3. The same LINE account again: no phone step, because the binding exists. */
    const returningToken = await lineStub.mintIdToken(LINE_SUBJECT);
    const returningContext = await liffContext(browser, { inClient: true, token: returningToken }, standIn);
    const returning = await openEntry(returningContext);
    await waitForPath(returning.page, (path) => !path.startsWith(LIFF_ENTRY_PATH), 25_000);
    check(
      returning.page.url().startsWith(`${base}/shop/products`),
      `the same LINE account in a fresh browser signs straight in (${returning.page.url().replace(base, '')})`,
    );
    check(
      (await returning.page.locator('#linePhone').count()) === 0,
      'and is never asked for a number, which is what one tap means',
    );

    /*
     * 4. A token LINE did not issue for this channel — the control the three above need.
     *
     * The key set is one this process serves, so "the customer was signed in" says nothing about
     * the verifier unless a token it *should* refuse is refused. This is the check that keeps the
     * sign-ins above from passing because a door accepted anything with a signature on it.
     */
    const foreignToken = await lineStub.mintIdToken('liff-door-foreign', { channelId: '9999999999' });
    const foreignContext = await liffContext(browser, { inClient: true, token: foreignToken }, standIn);
    const foreign = await openEntry(foreignContext);
    const refused = await foreign.page
      .getByText('เข้าสู่ระบบไม่ได้', { exact: false })
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!refused) {
      await diagnose(foreign.page);
    }
    check(refused, 'a token minted for another LINE channel is refused, and the entry says so');
    check(
      (await foreign.page.locator('#linePhone').count()) === 0,
      'and it never reaches the phone step, so the audience was checked and not merely the signature',
    );
    check(
      (await foreignContext.cookies(base)).every((cookie) => cookie.name !== 'pos_session'),
      'and it earns no session',
    );

    /* 5. Outside LINE: said plainly, and LINE is never asked to log anybody in. */
    const outsideContext = await liffContext(browser, { inClient: false, token: firstToken }, standIn);
    const outside = await openEntry(outsideContext);
    await outside.page
      .getByText('ลิงก์นี้ใช้ได้ในแอป LINE เท่านั้น', { exact: false })
      .waitFor({ state: 'visible', timeout: 20_000 });
    check(
      (await outside.page.getByRole('button', { name: 'ไปหน้าเข้าสู่ระบบ' }).count()) === 1,
      'a link opened outside LINE names the app and points at the ordinary door',
    );
    const outsideCalls = await liffCalls(outside.page);
    check(
      !outsideCalls.some((call) => call.method === 'getIDToken'),
      'and does not ask LINE for a token a browser that is not LINE cannot have',
    );
    check(
      (await outsideContext.cookies(base)).every((cookie) => cookie.name !== 'pos_session'),
      'and signs nobody in from an address that was opened in the wrong place',
    );

    /* 6. LINE's script will not load, and the shop has no entry configured at all. */
    const brokenContext = await liffContext(browser, { inClient: true, failInit: true }, standIn);
    const broken = await openEntry(brokenContext);
    await broken.page
      .getByText('โหลดตัวช่วยของ LINE ไม่สำเร็จ', { exact: false })
      .waitFor({ state: 'visible', timeout: 20_000 });
    check(
      (await broken.page.getByRole('button', { name: 'ไปหน้าเข้าสู่ระบบ' }).count()) === 1,
      'an SDK that will not load says so and offers the door that works',
    );

    /*
     * The unconfigured shop needs a **second server**: `LINE_LIFF_ID` is read per request by the
     * page, but it is read from the *server's* environment, and this process cannot rewrite
     * another process's. `limiter:race` already starts two servers on one scratch schema, so the
     * shape is this repository's; the env is restored before the first server is torn down,
     * because the runs above are over by now.
     */
    const configuredLiffId = process.env.LINE_LIFF_ID;
    process.env.LINE_LIFF_ID = '';
    const barePort = await freePort(3401);
    const bareBase = `http://localhost:${barePort}`;
    const bareStarted = startServer(scratch, barePort);
    bareServer = bareStarted.child;
    await waitForServer(bareBase, bareServer, bareStarted.log);
    const bareContext = await liffContext(browser, { inClient: true, token: firstToken }, standIn);
    const barePage = (
      await openEntry(bareContext, `${bareBase}${LIFF_ENTRY_PATH}`)
    ).page;
    await barePage
      .getByText('ยังไม่ได้ตั้งค่าทางเข้า LINE', { exact: false })
      .waitFor({ state: 'visible', timeout: 20_000 });
    check(
      (await barePage.getByRole('button', { name: 'ไปหน้าเข้าสู่ระบบ' }).count()) === 1,
      'a shop with no LIFF app says the entry is not set up, and where the normal doors are',
    );
    check(
      (await liffCalls(barePage)).length === 0,
      'and never loads LINE at all, because there is no app to open',
    );
    process.env.LINE_LIFF_ID = configuredLiffId;

    console.log(
      `\nliff door: ${checks} checks, all passed — ${engine}, with ${LIFF_SIGN_IN_ENDPOINT} verified ` +
        `against a real ES256 id token\n`,
    );
  } catch (error) {
    console.error(`\nliff door could not complete:\n${error instanceof Error ? error.stack : error}`);
    if (serverLog !== null) {
      const said = serverLog().trim().split('\n').slice(-15).join('\n');
      console.error(`\nlast thing the server said:\n${said}`);
    }
    process.exitCode = 1;
  } finally {
    if (browser !== null) {
      await browser.close();
    }
    if (otpGateway !== null) {
      await new Promise<void>((resolve) => otpGateway!.close(() => resolve()));
      otpGateway = null;
    }
    if (bareServer !== null) {
      await stopServer(bareServer);
      bareServer = null;
    }
    if (server !== null) {
      await stopServer(server);
    }
    if (lineStub !== null) {
      await lineStub.close();
    }
    if (!keep) {
      await resetScratchSchema(source!, schema, false).catch(() => undefined);
    }
  }
}

void main();
