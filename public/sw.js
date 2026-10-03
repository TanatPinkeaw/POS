/**
 * The till's own shell, so a prepared till can be opened with the network gone. ADR 0024.
 *
 * The offline till (ADR 0019) already holds everything a sale needs in the device's own
 * IndexedDB — the catalogue, the borrowed receipt and call numbers, the bills still to
 * send. What it did not hold was **itself**: `/pos` is a dynamic server page, so a till
 * whose machine had just rebooted met the browser's own "can't reach this site" page
 * before any of that storage was ever consulted. This file is the missing half. Open the
 * shell, and the IndexedDB half is there waiting.
 *
 * **What may be cached is the whole safety policy of this feature**, so it is written out
 * rather than configured:
 *
 *  1. **The API is never cached.** `/api/**` answers questions about money — the price,
 *     the stock, the open drawer. A cached price is a wrong amount handed to a customer,
 *     and the till already has the honest answer for an outage: it refuses, in the
 *     operator's own words. This worker adds no second, quieter source of truth.
 *  2. **Only the shell is cached** — the till's own HTML documents and the hashed assets
 *     they reference. Nothing here is state. A stale shell renders the same screen it
 *     always did and then asks the device what it knows.
 *  3. **Routes, not windows.** A navigation is answered from the cache only for the four
 *     till screens a device prepares. Anything else gets an honest "no connection" page
 *     rather than a plausible-looking document from an unknown moment.
 *  4. **It never writes IndexedDB.** The till's money storage is `offline-db.ts`'s and
 *     this worker does not know its schema; two writers to one store is how a committed
 *     bill stops being a committed bill.
 *
 * **Why nothing is precached at install.** The till routes are `force-dynamic` — a till is
 * never a cached document, because its stock counts are only correct for the second they
 * were read — so there is no HTML on disk to precache and no build manifest that could name
 * one honestly. Instead the shell is remembered from the last successful online visit: the
 * response is stored under its own path, and the content-hashed `/_next/static/…`
 * references inside it are fetched and stored with it. A chunk URL changes when the code
 * changes, which is what makes caching it forever safe.
 *
 * **One cache, one version.** Chunks are never evicted, so an older cached document keeps
 * working even after a deploy replaced the chunks it named — the failure this avoids is a
 * white screen on a till in a shop mid-sale, which is the worst place for one. Bump
 * `cacheName` when the strategy itself changes; nothing else needs it.
 *
 * **Development does not register this** (see `OfflineShellRegistrar`), because a worker
 * that serves a cached document is the single hardest class of bug to see locally.
 *
 * The `var` bindings and the function declaration below are deliberate: `tests/offline-shell.test.ts`
 * loads *this file* into a `node:vm` context and asserts on them, so the rules under test
 * are the rules that ship. A twin module in `src/` would be a second copy that drifts.
 */

var LN_SHELL = {
  cacheName: 'ln-till-shell-v1',
  /** The screens a prepared device has, and the only ones it may show with no network. */
  offlineRoutes: ['/pos', '/pos/queue', '/pos/preorders', '/pos/attendance'],
  /** Content-hashed, immutable, safe to serve from the cache first and only. */
  staticPrefix: '/_next/static/',
  /** Never touched by this worker: the money path, the socket, and dev's live reload. */
  bypassPrefixes: ['/api/', '/socket.io/', '/_next/webpack-hmr', '/__nextjs'],
};

/**
 * How one request is answered.
 *
 * `'bypass'` means this worker stands aside entirely. That is the answer for anything that
 * is not a document or a static file, and it is deliberately the answer for App Router
 * *flight* requests too (`?_rsc=`, or the `RSC` header): those carry a rendered payload,
 * never a document, so handing one a cached HTML file produces a router error rather than
 * a page. Failing honestly is better than serving something the router cannot read — and
 * the till's own navigation stops asking for them, because an offline nav link is a plain
 * anchor and so a full document load.
 */
function classify(request, url) {
  if (request.method !== 'GET') return 'bypass';
  if (url.origin !== self.location.origin) return 'bypass';
  if (url.pathname === '/api' || LN_SHELL.bypassPrefixes.some(function (prefix) { return url.pathname.indexOf(prefix) === 0; })) {
    return 'bypass';
  }
  if (request.headers.has('RSC') || url.searchParams.has('_rsc') || request.headers.has('Next-Router-State-Tree')) {
    return 'bypass';
  }
  if (url.pathname.indexOf(LN_SHELL.staticPrefix) === 0) return 'asset';
  if (request.mode === 'navigate') return 'navigation';
  return 'runtime';
}

/** The cache key for a document: its own path, with no query and no flight headers. */
function documentKey(href) {
  var url = new URL(href);
  return new Request(url.origin + url.pathname);
}

function isOfflineRoute(pathname) {
  return LN_SHELL.offlineRoutes.indexOf(pathname) !== -1;
}

/** The hashed assets a stored document refers to, as absolute URLs. */
function harvestAssets(html) {
  var found = String(html).match(/\/_next\/static\/[^"'\\\s<>]+/g);
  if (!found) return [];
  var unique = [];
  for (var i = 0; i < found.length; i += 1) {
    var absolute = new URL(found[i], self.location.origin).href;
    if (unique.indexOf(absolute) === -1) unique.push(absolute);
  }
  return unique;
}

/**
 * Store a document and everything it needs to render.
 *
 * The response is stored as text rather than as the `Response` it arrived as, for one
 * reason: App Router answers with `Vary: RSC, Next-Router-State-Tree…`, and a cache that
 * honours `Vary` will refuse to hand a stored document to a request that carries none of
 * those headers — the entry would be there and unreachable. A document with a plain HTML
 * content type is what it is being asked to be, so it is stored as one.
 */
async function rememberDocument(cache, key, response) {
  var html = await response.clone().text();
  await cache.put(
    key,
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  );
  var assets = harvestAssets(html);
  await Promise.all(
    assets.map(function (href) {
      // One asset that will not load must not cost the till the other forty: a chunk that
      // 404s against the document just stored is one that document never asks for anyway.
      return cache.add(href).catch(function () {});
    }),
  );
}

/** The page shown for a route this worker will not serve offline. */
function offlineDocument() {
  return new Response(
    '<!doctype html><html lang="th"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>ไม่มีการเชื่อมต่อ · เหลี่ยมนอก</title></head>' +
      '<body style="font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0c0d15;color:#f4f4f7">' +
      '<main style="max-width:28rem;padding:2rem;text-align:center">' +
      '<h1 style="font-size:1.25rem;margin:0 0 .5rem">ไม่มีการเชื่อมต่อ</h1>' +
      '<p style="margin:0;color:#a7a7b4;line-height:1.7">หน้านี้ยังเปิดออฟไลน์ไม่ได้ เพราะเครื่องนี้ไม่ได้เตรียมไว้ล่วงหน้า<br>' +
      'หน้าขายหน้าร้าน คิวเครื่องดื่ม พรีออเดอร์ และลงเวลา เปิดได้ตามปกติ</p></main></body></html>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

async function handleAsset(request) {
  var cache = await caches.open(LN_SHELL.cacheName);
  var cached = await cache.match(request);
  if (cached) return cached;
  var response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

async function handleNavigation(request) {
  var cache = await caches.open(LN_SHELL.cacheName);
  var url = new URL(request.url);
  var key = documentKey(request.url);
  try {
    var response = await fetch(request);
    if (response.ok && response.type === 'basic' && isOfflineRoute(url.pathname)) {
      await rememberDocument(cache, key, response);
    }
    return response;
  } catch (error) {
    // Offline. The four prepared screens are served from what the last visit stored; the
    // rest are told the truth rather than sent a document from an unknown moment.
    var stored = await cache.match(key);
    if (stored) return stored;
    return offlineDocument();
  }
}

async function handleRuntime(request) {
  var cache = await caches.open(LN_SHELL.cacheName);
  try {
    var response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
    return response;
  } catch (error) {
    var stored = await cache.match(request);
    if (stored) return stored;
    throw error;
  }
}

self.addEventListener('install', function () {
  // Nothing to precache — see the header. Take over as soon as the worker is ready so a
  // till that has just installed it does not need a second reload to benefit.
  return self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (name) { return name !== LN_SHELL.cacheName; })
            .map(function (name) { return caches.delete(name); }),
        );
      })
      .then(function () { return self.clients.claim(); }),
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var kind = classify(request, new URL(request.url));
  if (kind === 'bypass') return;
  if (kind === 'asset') {
    event.respondWith(handleAsset(request));
    return;
  }
  if (kind === 'navigation') {
    event.respondWith(handleNavigation(request));
    return;
  }
  event.respondWith(handleRuntime(request));
});