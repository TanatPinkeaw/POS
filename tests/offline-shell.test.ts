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
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const ORIGIN = 'http://till.test';

interface ShellContext {
  LN_SHELL: { cacheName: string; offlineRoutes: string[]; staticPrefix: string; bypassPrefixes: string[] };
  classify(request: unknown, url: URL): string;
  isOfflineRoute(pathname: string): boolean;
  harvestAssets(html: string): string[];
  documentKey(href: string): { url: string };
}

/** Runs the shipped worker with just enough of a worker global to load. */
function loadShell(): ShellContext {
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
  });
  runInContext(readFileSync('public/sw.js', 'utf8'), context);
  return context as unknown as ShellContext;
}

const shell = loadShell();

/**
 * A request built as a plain object.
 *
 * `mode: 'navigate'` cannot be constructed — a real navigation Request is made by the
 * browser and is not constructible — and `classify` only ever reads three fields, so the
 * shape is faked rather than simulated. The worker is tested against the fields it uses.
 */
const request = (href: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}): unknown => ({
  method: init.method ?? 'GET',
  mode: init.mode ?? 'no-cors',
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