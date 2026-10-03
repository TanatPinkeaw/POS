# ADR 0024 — A prepared till launches without the network

**Status:** accepted (2026-10-03)
**Context:** ADR 0019 built the offline till and stopped one sentence short of done.
`docs/offline-till-spec.md` closed with the words *"There is no cold offline app launch
or service worker"*, and that sentence turned out to hide **two** separate gaps rather
than one.

The first is the obvious one. `/pos` is a `force-dynamic` server page — it calls
`requireRole`, reads the catalogue and the shop — so a till whose machine has just
rebooted meets the browser's own "can't reach this site" page before any of the
device's IndexedDB is ever consulted. Every sale-until-reconnect guarantee in ADR 0019
had an asterisk on it: *as long as this tab was open when the line went down.* A till is
a machine on a counter that gets power-cycled, and a promise with that asterisk is not
the promise a shop is buying.

The second is quieter and was not written down anywhere. With the shell served, the page
mounts, and `useOpenShift` reads `/api/v1/shifts/current`. With no network that request
fails, `shift` stays `null`, and `useTill`'s `payBlockedReason` reports **"ยังไม่เปิดลิ้นชัก —
เปิดก่อนจึงจะรับชำระเงินได้"** about a drawer that a person opened at that counter that
morning and that is still sitting there. A stale price is a wrong amount handed over; a
drawer reported as closed is a till that cannot take money at all, and it reports the
wrong reason, which sends the cashier to open a second drawer.

## Decisions

### 1. The device keeps a shell, and the shell is only the shell

A hand-written service worker (`public/sw.js`) answers with cached bytes for exactly two
kinds of request: a navigation to one of the four till screens, and the
content-hashed `/_next/static/…` files those screens refer to. Everything else goes to
the network.

That boundary is the whole safety policy, so it is enforced by a classifier that is unit
tested against the shipped file (`tests/offline-shell.test.ts`): the API, the socket, dev's
live reload, every non-GET, everything cross-origin, and App Router **flight** requests
all return `bypass` — this worker stands aside completely.

Flight requests are the subtle one. `?_rsc=` and the `RSC` header carry a rendered
payload, never a document; handing one a cached HTML file produces a router error rather
than a page. Failing honestly beats serving something the router cannot read, and
decision 6 removes the reason a till would ever ask for one while offline.

**The rejected alternative was to cache the API.** It is what most PWA tutorials do and it
would have made this feature smaller to build. It is refused because `/api/**` answers
questions about money — the price, the stock, the drawer — and ADR 0019 already gives an
outage the honest answer, in the operator's own words, at the moment of sale. A cached
price is a second, quieter source of truth that nobody can see and nobody can clear.

### 2. Nothing is precached at install; the shell is remembered from the last online visit

The till routes are dynamic, so there is no HTML on disk to precache and no build manifest
that could name one honestly. Instead, each successful navigation to a till screen is
stored under its own path, and the hashed assets named inside that document are fetched
and stored with it.

This is why the till pages are `force-dynamic` and this is why that is not a problem here:
a chunk URL changes when the code changes, which is exactly what makes caching one forever
safe. A document is stored as text rather than as the `Response` it arrived as, because
App Router answers with `Vary: RSC, Next-Router-State-Tree…` and a cache that honours
`Vary` refuses to hand a stored document to a request carrying none of those headers — the
entry would be there and unreachable.

### 3. One versioned cache, and nothing is ever evicted

`ln-till-shell-v1`, deleted wholesale only when the version changes. Chunks are never
pruned, so a cached document keeps rendering even after a deploy replaced the chunks it
named.

The failure this prevents is a **white screen on a till in the middle of a shift**, which
is the worst place for one and the hardest to diagnose in the field. The price is a few
megabytes of orphaned chunks per version, which is not a trade worth optimising. Bump the
version when the *strategy* changes; nothing else needs it.

### 4. The drawer is the one thing a device may answer from memory

`offline-drawer.ts` answers one narrow question — was this device mid-shift and prepared
when it last saw the server? — and every rule in it is a refusal:

- **Preparation is required.** `heldBlocks` (the borrowed receipt and call-number ranges)
  exists only on a device a cashier prepared while online. An unprepared till was never
  allowed to take offline money, so it is not allowed to claim it is mid-shift now.
- **A closed drawer stays closed.** A normal close releases every loan, so it leaves no
  block behind and cannot reappear on tomorrow's till.
- **A broken store answers "no"**, rather than throwing, because a read that fails must
  not take the till screen down with it.

The fallback is only reached when the request **never reached the server** (`isOfflineFailure`
in `client-api.ts`), never when the server refused — a locked PIN, an empty shelf or an
expired session are the server's answers and must be shown as such.

The remembered figures are labelled. The drawer block says **"ลิ้นชักนี้มาจากข้อมูลในเครื่อง"**
with the capture time, and the takings pill says **"(จากเครื่อง)"**, because a shift total
read ten minutes ago and shown as a live one is the same class of lie as a stale price. The
snapshot now carries `openedAt` and the takings for exactly this reason: a drawer described
by its id alone would leave the header unable to say which shift it is in.

### 5. A prepared device may show its own four screens offline, and no others

`isOfflineRoute` matches `/pos`, `/pos/queue`, `/pos/preorders` and `/pos/attendance`
exactly. `/admin/dashboard` is not one of them, and neither is `/pos/reports` — `/pos`
must not make every path below it answerable.

Any other navigation that fails gets an honest 503 page naming the four screens that do
work, rather than a plausible-looking document from an unknown moment. This is the same
principle ADR 0019 applies to the till refusing a sale it cannot keep: **say the smaller
truth.**

### 6. Offline navigation is a document load, not a router change

`NavEntry` in the application frame draws each nav item as a plain `<a>` while
`navigator.onLine` is false, and as a router link otherwise. A client-side route change
needs the server to render a payload; with no network it can only fail, and a cashier
tapping "คิวเครื่องดื่ม" on a dead line should get that screen rather than an error
boundary.

Only `href` changes — same element, same classes, same badge — so nothing about the frame's
appearance or its accessibility depends on which is drawn. The signal is the browser's own
`navigator.onLine`, not the socket indicator: a captive portal needs the plain link, and a
dropped websocket with a working network does not.

### 7. No dependency, and the shipped file is the tested one

`AGENTS.md` rule 2 forbids a dependency for something small, and this is not even small:
it is the rule that decides what this application remembers about a customer's money.
`@serwist/next` would have put that rule in a plugin's configuration file.

So the worker is written out, and `tests/offline-shell.test.ts` loads **that file** into a
`node:vm` context and asserts on it. A worker cannot import the application's code — it is
served as a plain script at a stable URL — so the usual arrangement would be a pure module
in `src/` plus a hand-copied version inside the worker: two copies of the money-path rule,
one untested, both destined to drift. Loading the shipped file makes that impossible. It
is the same move `scripts/offline-browser.ts` makes with `offline-db.ts`, one layer
earlier.

### 8. Development does not register it

`OfflineShellRegistrar` returns early unless `NODE_ENV === 'production'`. A worker that
answers with a cached document is the hardest class of bug to see while working: the change
you just made is not the page in front of you, and the fix is a cache you have to find.

## Consequences

- A prepared till survives a reboot. Open the machine with no network and the till screen
  loads, the drawer is there, the catalogue is there, and a cash sale commits to the
  device queue and walks to the server on reconnect — all four proven in
  `scripts/offline-browser.ts` (real Chromium, real IndexedDB, real PostgreSQL), which runs
  in `verify:all` and in CI.
- A till that was never prepared behaves exactly as before: the shell does not load, or
  loads and refuses in its own words. Nothing about the unprepared path is newly permissive.
- The API is provably never answered from the cache; the journey asserts it with a real
  `fetch` against a real offline context, because that is the claim everything else rests on.
- A browser used as a till keeps this worker on the origin. Everything outside the four
  prepared screens is passed straight through, so no other screen's behaviour changes.
- The offline till's own notice ("an outage the till does not mention is the silent
  failure the offline work exists for") is now reachable from a cold start, which is where
  it was most needed.

## Known gaps, stated rather than discovered

- **Service workers need HTTPS or localhost.** `docs/homelab-deploy.md` already requires
  TLS for the session cookie and recommends Tailscale Serve, so a correctly deployed till
  satisfies this — but a shop that puts this on a plain-HTTP LAN address gets no shell, and
  nothing warns them. The register call's `.catch()` is silent by design (a browser that
  refuses the worker still sells online); it is silent here too.
- **This is not an installable app.** No manifest icon set beyond what ADR 0015 already
  ships, no prompt, no update flow. The worker updates on the next page load, which is
  whenever the till next opens.
- **Browser storage is evictable.** Under pressure, a browser may drop Cache Storage
  entries; an iPad that has been offline for weeks is the realistic case. The till then
  falls back to the honest "no connection" page — no wrong data, but no sale either, and
  nothing tells the cashier why the shell stopped being there.
- **RSC payloads are never cached**, so any client-side navigation that is not one of the
  four nav links — a link inside a page body, a browser back button, a programmatic push —
  will still fail offline. Decision 6 covers the navigation the cashier actually uses; it
  does not cover the others, and pretending otherwise would mean caching payloads whose
  staleness nothing tracks.
- **Chunks accumulate within a version.** Deliberate (decision 3), and it means the cache
  is never smaller than the sum of every build the till has seen since the version last
  changed.
- **The worker is per-origin, so the display screen is not covered** and never asked to be.
  `/display` sits outside the till area, registers nothing, and behaves exactly as before.
- **`cache.add` failures during harvesting are swallowed.** One asset that will not load
  must not cost the till the other forty; the failure mode is a page that loads and misses
  one chunk, which the browser reports honestly.