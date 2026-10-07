/**
 * The rules the shipped service worker answers requests by — ADR 0024.
 *
 * This suite reads `public/sw.js` and runs *it* in a `node:vm` context, rather than
 * importing a module written beside it. A worker cannot `import` the application's code
 * (it is served as a plain script at a stable URL), so the usual arrangement would be a
 * pure module in `src/` plus a hand-copied version inside the worker — two copies of the
 * rule that decides what this application is allowed to remember about a customer's money,
 * one of which is untested and both of which will drift. Loading the shipped file is the
 * arrangement that makes the copy problem impossible; it is the same move
 * `scripts/offline-browser.ts` makes with `offline-db.ts`, one layer earlier.
 *
 * The vm context is given Node's `URL`, `Request` and `Response` explicitly, because a vm
 * context starts with the ECMAScript built-ins and nothing else.
 *
 * The handler tests at the bottom are a *field* regression. On the shop's own
 * deployment the console carried two errors from this file — `The FetchEvent for
 * "https://…/login" resulted in a network error response: the promise was rejected`
 * and an uncaught `TypeError: Failed to fetch` from `handleRuntime` — and the shape
 * that produced them was the worker's own: `caches.open()` outside a `try` (a
 * CacheStorage that is unavailable — private browsing, a storage-blocked browser —
 * rejected every request the worker managed, including documents and chunks), a
 * `cache.put()` whose failure threw away a response that had already arrived, and a
 * `handleRuntime` that rethrew on purpose. A worker may answer "no", but it must not
 * reject: a rejection is a console error and, for a navigation, a page the customer
 * never sees.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { beforeEach, describe, expect, it } from 'vitest';

const ORIGIN = 'http://till.test';

interface ShellContext {
  LN_SHELL: { cacheName: string; offlineRoutes: string[]; staticPrefix: string; bypassPrefixes: string[] };
  classify(request: unknown, url: URL): string;
  isOfflineRoute(pathname: string): boolean;
  harvestAssets(html: string): string[];
  documentKey(href: string): { url: string };
  handleAsset(request: unknown): Promise<Response>;
  handleNavigation(request: unknown): Promise<Response>;
  handleRuntime(request: unknown): Promise<Response>;
}

/** A CacheStorage entry, small enough to reason about and honest about failures. */
interface FakeCache {
  entries: Map<string, Response>;
  match(request: unknown): Promise<Response | undefined>;
  put(request: unknown, response: Response): Promise<void>;
  add(url: string): Promise<void>;
}

/**
 * What the worker is given to work with, and what the test can bend.
 *
 * `fetch` and `caches` are delegated through this box rather than closed over, so a
 * single loaded context can be asked "and what if the network is gone?" one test at
 * a time without reloading the shipped file for each case.
 */
interface Harness {
  cache: FakeCache;
  respondWith: (response: Response | (() => Promise<Response>)) => void;
  networkFails: () => void;
  cacheUnavailable: () => void;
  cacheWriteFails: () => void;
  reset: () => void;
}

function key(request: unknown): string {
  return typeof request === 'string' ? request : String((request as { url?: string }).url);
}

/**
 * A response shaped the way a real same-origin fetch answers *inside a worker*.
 *
 * `Response.type` is `'basic'` for a same-origin response and `'default'` for one this
 * script constructed, and it cannot be set on the constructor — but the worker's rule
 * ("cache only what is genuinely ours to keep, never an opaque response") is decided by
 * that field, so a stub made of `new Response(...)` would test the wrong branch of it.
 */
function basic(body: string, status = 200): Response {
  const shape = {
    ok: status >= 200 && status < 300,
    status,
    type: 'basic',
    clone: () => basic(body, status),
    text: async (): Promise<string> => body,
  };
  return shape as unknown as Response;
}

function makeCache(): FakeCache {
  const entries = new Map<string, Response>();
  return {
    entries,
    async match(request: unknown) {
      const hit = entries.get(key(request));
      return hit ? hit.clone() : undefined;
    },
    async put(request: unknown, response: Response) {
      entries.set(key(request), response.clone());
    },
    async add(url: string) {
      entries.set(url, new Response('asset'));
    },
  };
}

/** Runs the shipped worker with just enough of a worker global to load. */
function loadHarness(): { shell: ShellContext; harness: Harness } {
  const cache = makeCache();
  let answer: Response | (() => Promise<Response>) = new Response('from the network', { status: 200 });
  let failNetwork = false;
  let openFails = false;
  let writeFails = false;

  const stub = {
    location: { origin: ORIGIN },
    addEventListener: () => {},
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const context = createContext({
    self: stub,
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    console,
    fetch: async (): Promise<Response> => {
      if (failNetwork) {
        throw new TypeError('Failed to fetch');
      }
      return typeof answer === 'function' ? answer() : answer.clone();
    },
    caches: {
      open: async (): Promise<FakeCache> => {
        if (openFails) {
          throw new Error('CacheStorage is not available');
        }
        if (writeFails) {
          return { ...cache, put: async () => { throw new Error('QuotaExceededError'); } };
        }
        return cache;
      },
      keys: async (): Promise<string[]> => [cacheKeyName],
      delete: async (): Promise<boolean> => true,
    },
  });
  runInContext(readFileSync('public/sw.js', 'utf8'), context);

  return {
    shell: context as unknown as ShellContext,
    harness: {
      cache,
      respondWith: (response) => {
        answer = response;
      },
      networkFails: () => {
        failNetwork = true;
      },
      cacheUnavailable: () => {
        openFails = true;
      },
      cacheWriteFails: () => {
        writeFails = true;
      },
      reset: () => {
        cache.entries.clear();
        answer = new Response('from the network', { status: 200 });
        failNetwork = false;
        openFails = false;
        writeFails = false;
      },
    },
  };
}

const cacheKeyName = 'ln-till-shell-v1';

const { shell, harness } = loadHarness();

beforeEach(() => {
  harness.reset();
});

/**
 * A request built as a plain object.
 *
 * `mode: 'navigate'` cannot be constructed — a real navigation Request is made by the
 * browser and is not constructible — and `classify` only ever reads four fields, so the
 * shape is faked rather than simulated. The worker is tested against the fields it uses.
 */
const request = (
  href: string,
  init: { method?: string; mode?: string; destination?: string; headers?: Record<string, string> } = {},
): unknown => ({
  method: init.method ?? 'GET',
  mode: init.mode ?? 'no-cors',
  destination: init.destination ?? '',
  url: href,
  headers: new Headers(init.headers ?? {}),
});

const kind = (href: string, init?: Parameters<typeof request>[1]): string =>
  shell.classify(request(href, init), new URL(href));

describe('the till shell worker', () => {
  it('never touches the money path', () => {
    // The single most important line in the file: a cached price is a wrong amount handed
    // over a counter, and the till already refuses an outage in words rather than in guesses.
    expect(kind(`${ORIGIN}/api/v1/shifts/current`, { mode: 'navigate' })).toBe('bypass');
    expect(kind(`${ORIGIN}/api/v1/pos/sync`, { method: 'POST' })).toBe('bypass');
    expect(kind(`${ORIGIN}/api/v1/products?barcode=OB1`)).toBe('bypass');
    expect(kind(`${ORIGIN}/api`)).toBe('bypass');
  });

  it('stands aside for the socket, the dev reload and anything off-origin', () => {
    expect(kind(`${ORIGIN}/socket.io/?EIO=4&transport=websocket`)).toBe('bypass');
    expect(kind(`${ORIGIN}/_next/webpack-hmr`)).toBe('bypass');
    expect(kind('https://cdn.example.com/chart.js')).toBe('bypass');
    expect(kind(`${ORIGIN}/api/v1/orders`, { method: 'DELETE' })).toBe('bypass');
  });

  it('never answers an App Router flight request from the cache', () => {
    // A flight response is a rendered payload, not a document. Handing one a cached HTML
    // file produces a router error rather than a page.
    expect(kind(`${ORIGIN}/pos?_rsc=1a2b3c`, { mode: 'navigate' })).toBe('bypass');
    expect(kind(`${ORIGIN}/pos`, { mode: 'navigate', headers: { RSC: '1' } })).toBe('bypass');
    expect(
      kind(`${ORIGIN}/pos`, { mode: 'navigate', headers: { 'Next-Router-State-Tree': '%5B%22%22%5D' } }),
    ).toBe('bypass');
  });

  it('serves hashed assets from the cache first', () => {
    expect(kind(`${ORIGIN}${shell.LN_SHELL.staticPrefix}chunks/4f2a-main.js`)).toBe('asset');
    expect(kind(`${ORIGIN}${shell.LN_SHELL.staticPrefix}css/9c1c.css`)).toBe('asset');
  });

  it('treats a document as a document and everything else as a small file', () => {
    expect(kind(`${ORIGIN}/pos`, { mode: 'navigate' })).toBe('navigation');
    expect(kind(`${ORIGIN}/manifest.webmanifest`)).toBe('runtime');
    expect(kind(`${ORIGIN}/icon-192.png`)).toBe('runtime');
  });

  it('treats a document the browser did not call a navigation as one anyway', () => {
    // `mode` is not the only way a document arrives: a `rel=prefetch` of a page, and
    // some in-app browsers, carry `destination: 'document'` with an ordinary mode. The
    // live failure was a *document* request falling through to `runtime`, whose last
    // line rethrew — which is the FetchEvent rejection the shop's console recorded.
    expect(kind(`${ORIGIN}/login`, { destination: 'document' })).toBe('navigation');
    expect(kind(`${ORIGIN}/login`, { destination: 'document', mode: 'no-cors' })).toBe('navigation');
  });

  it('names exactly the four screens a prepared device has', () => {
    expect(shell.LN_SHELL.offlineRoutes).toEqual(['/pos', '/pos/queue', '/pos/preorders', '/pos/attendance']);
    for (const route of shell.LN_SHELL.offlineRoutes) {
      expect(shell.isOfflineRoute(route)).toBe(true);
    }
    // A route the till never prepared, and a prefix of one it did — `/pos` must not make
    // every path below it answerable offline.
    expect(shell.isOfflineRoute('/admin/dashboard')).toBe(false);
    expect(shell.isOfflineRoute('/pos/reports')).toBe(false);
    expect(shell.isOfflineRoute('/pos')).toBe(true);
  });

  it('keys a document by its own path, so no query can smuggle one past the cache', () => {
    expect(shell.documentKey(`${ORIGIN}/pos?utm=x`).url).toBe(`${ORIGIN}/pos`);
  });

  it('harvests only hashed assets from a stored document', () => {
    const html = [
      '<script src="/_next/static/chunks/abc.js"></script>',
      '<link rel="stylesheet" href="/_next/static/css/def.css">',
      '<script src="/_next/static/chunks/abc.js"></script>',
      '<a href="/admin/dashboard">ไม่ใช่ไฟล์</a>',
      '<img src="/icon-192.png">',
    ].join('');
    expect(shell.harvestAssets(html)).toEqual([
      `${ORIGIN}/_next/static/chunks/abc.js`,
      `${ORIGIN}/_next/static/css/def.css`,
    ]);
    expect(shell.harvestAssets('<p>ไม่มีชิ้นส่วนเลย</p>')).toEqual([]);
  });

  it('keeps one versioned cache, so a document outlives the chunks it named', () => {
    // The white-screen failure this prevents is a till breaking in the middle of a shift
    // after a deploy: a new build deletes old chunks, and a cached document pointing at
    // them would render nothing. Never evicting them is the cheap way to be safe.
    expect(shell.LN_SHELL.cacheName).toMatch(/^ln-till-shell-v\d+$/);
  });
});

describe('answering a request the worker cannot serve', () => {
  it('answers a document with the offline page rather than rejecting', async () => {
    harness.networkFails();

    const response = await shell.handleNavigation(request(`${ORIGIN}/login`, { mode: 'navigate' }));

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('ไม่มีการเชื่อมต่อ');
  });

  it('answers a navigation even when the cache itself is unusable', async () => {
    // Private browsing, a storage-blocked browser and a corrupted cache all look like
    // this: `caches.open` rejects. It used to be called outside the `try`, so *every*
    // request the worker managed — documents and hashed chunks alike, which is a white
    // page on a till mid-shift — rejected with it.
    harness.cacheUnavailable();

    const page = await shell.handleNavigation(request(`${ORIGIN}/pos`, { mode: 'navigate' }));
    expect(page.status).toBe(200);

    harness.networkFails();
    const offline = await shell.handleNavigation(request(`${ORIGIN}/pos`, { mode: 'navigate' }));
    expect(offline.status).toBe(503);
  });

  it('still serves a hashed asset when the cache is unusable', async () => {
    harness.cacheUnavailable();

    const response = await shell.handleAsset(request(`${ORIGIN}/_next/static/chunks/abc.js`));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('from the network');
  });

  it('does not throw a good response away because the cache refused to store it', async () => {
    // A quota error on the *write* is not a reason to fail the *read*: the response in
    // hand is the one the page asked for. This is the second of the two shapes that
    // produced the field errors, and it is invisible until a cache fills.
    harness.cacheWriteFails();

    const asset = await shell.handleAsset(request(`${ORIGIN}/_next/static/chunks/abc.js`));
    expect(asset.status).toBe(200);

    const runtime = await shell.handleRuntime(request(`${ORIGIN}/icon-192.png`));
    expect(runtime.status).toBe(200);
  });

  it('answers an uncached small file with a response, not a rejected promise', async () => {
    // The uncaught `TypeError: Failed to fetch` in the shop's console came from here: a
    // request that was neither cached nor reachable rethrew the fetch failure. A worker
    // may say "no" — a 503 is a fact the page can act on — but it must not reject.
    harness.networkFails();

    const response = await shell.handleRuntime(request(`${ORIGIN}/icon-192.png`));

    expect(response.status).toBe(503);
  });

  it('serves a small file from the cache when the network is gone', async () => {
    harness.respondWith(basic('cached icon'));
    await shell.handleRuntime(request(`${ORIGIN}/icon-192.png`));

    harness.networkFails();
    const response = await shell.handleRuntime(request(`${ORIGIN}/icon-192.png`));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('cached icon');
  });
});
