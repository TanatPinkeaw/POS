# ADR 0016 — The rental is hosted: one database, a schema per shop

**Status:** accepted (2026-09-29). Supersedes ADR 0002 §1 for the hosted shape — that
decision ("one shop per deployment") is what the code does *today*; this one is what the
product is going to be.

**Context.** Everything in this repository assumes exactly one shop. `shops` is a
singleton — `id Int @id @default(1)` with `CHECK (id = 1)` — and **no other table carries
a shop key at all**: 21 models, and not one occurrence of `shopId` or `shop_id` between
them. That is not an oversight, it is what makes the load-bearing invariants *facts rather
than checks*: the gapless receipt and credit-note series are serialised on that one shop
row, a phone number or a barcode is unique because there is only one shop to be unique
within, and a racing second setup cannot win one, because the database refuses the row.

The decision now is the opposite of that: a shop **signs up with Google** and gets its own
space on a box we run. So most of this ADR is about how to get there without spending the
invariants above.

Three measurements decided the shape, all taken against this checkout rather than assumed:

- **`src/lib/db.ts` already knows how to live in a schema.** It builds its client from
  `DATABASE_URL` and honours a `?schema=` parameter — validating the name as a bare
  identifier before it is allowed anywhere near `search_path` — because the test suite and
  `acceptance` both run in scratch schemas today.
- **40 files import the one client** (`export const prisma = …`), which is the size of the
  seam, not the size of the rewrite: the client has to become per-request without every
  caller learning about it.
- **The realtime layer is global.** `src/lib/realtime.ts` has one socket server with
  `EVERYONE_ROOM`, `DISPLAY_ROOM` and `user:<id>` rooms, and the session token carries
  `sub`, `role`, `fullName`, `phone` — no shop anywhere.

## Decisions

### 1. A schema per shop in one database; `public` is the control plane

`shop_<slug>` holds one shop, identical to today's schema. `public` holds what is *ours*:
accounts, tenants, plan, status, slug.

Why this and not the two obvious alternatives:

- **Isolation is a property of the connection, not of a `WHERE` clause.** A shared table
  with a `shop_id` column leaks the moment one query forgets the predicate, and that
  failure is silent — a shop sees another shop's sales and nothing errors. Here a request
  that has lost its tenant lands on `public`, where the tenant tables do not exist, and
  the query fails loudly.
- **Every invariant stays literally true.** Inside a shop's schema the singleton is still a
  singleton, the receipt series is still serialised on its own row, and a phone number is
  unique *within the shop* — which is what "unique" should have meant all along. The suites
  that assert these keep their meaning instead of being rewritten around a tenant column.
- **A shop's data is one `pg_dump -n <schema>` away.** That is the same command as a backup,
  and the same command as *leaving* — which matters for a business that is asking shops to
  put their sales on somebody else's disk.

**Rejected — `shop_id` on every table plus row-level security.** Twenty models, every
unique constraint widened to a composite, RLS policies on top of hand-written migration
SQL, and a restore that means surgery on one shared dump. It buys a single connection pool
and cross-shop reporting, and pays for both with a leak class that is silent by
construction.

**Rejected — a database per shop.** The same isolation with heavier operations (a pool and
a migration run per database, `CREATE DATABASE` on every signup) and no extra safety that a
shop has asked for. It stays available as an *upsell* — a large shop that wants its own
box — because the seam is the same one, which is the point of choosing a schema.

**Rejected — a container per shop.** That is the self-hosted shape with us as the
installer. It is the thing this decision replaces, and it does not scale past the number of
boxes somebody is willing to babysit.

### 2. The tenant schema does not change

`prisma/schema.prisma` keeps describing one shop exactly as it does now. The control plane
is a separate, much smaller schema (`accounts`, `tenants`) in `public`.

A schema-per-shop model that also rewrote the tenant tables would spend the invariants of
decision 1 to buy nothing at all. It would also invalidate the SRS mapping in the README,
which is a document nobody should have to re-derive because of a hosting choice.

### 3. The seam has no default

One client per shop, resolved per request from the shop's host, and kept in
`AsyncLocalStorage` so that the 40 files importing `prisma` keep working unchanged. **A
request with no tenant throws.** There is no fallback client, because the fallback *is* the
bug: a request that quietly resolves to `public` reads the wrong tables, and a cache keyed
without the shop serves one shop's answer to another.

The tenant is carried by the **host** (`lam-nong.<domain>`) rather than by a path segment:
it is what a cookie, a QR code and an installed PWA already agree on, and it keeps one
shop's session from being usable at another's address.

### 4. Identity: the owner signs in with Google; the shop's staff keep phone and password

Google is the **tenant's** door, not the counter's. A cashier at 7am does not have a Gmail
account, and the till's login is the phone number the shop enrolled (ADRs 0010, 0011) —
which stays exactly as it is, resolved inside that shop's schema.

So an *account* (a person who pays us) and a *user* (a person who works in a shop) are two
different things that were the same table only because there was one shop and one door.

### 5. Two documents change audience, and that is a deliverable

`docs/homelab-deploy.md` stops being the renter's guide and becomes **our** operations
guide: the systemd units, the TLS and the backup timer are precisely what the box we run
needs, and nothing about them gets easier by being hosted.

`docs/renter-onboarding.md` loses its install half entirely — Node, PostgreSQL, `npm run
setup` and the superuser password are no longer anything a shop does — and becomes the
guide for the ten minutes after signup.

## Consequences

- **The money path is untouched.** Atomic stock reservation, VAT and tax-invoice
  arithmetic, gapless numbering, credit notes and per-line refunds, the four-phase
  pre-order, pickup codes, the audit trail: same code, same tests. That is the entire
  reason for choosing this shape, and it is worth stating plainly because it is the thing a
  reader will assume went wrong.
- **New operational surface, all of it ours**: a connection budget per shop (`max: 10` per
  client today, a figure that does not survive fifty shops and belongs behind a pooler),
  a migration loop across every schema, a backup and restore per shop, and a tenant
  lifecycle — create, suspend, export, delete.
- **The pitch flips.** `docs/wongnai-pos-gap-analysis.md` §1 names self-hosting and "your
  sales are not in somebody else's cloud" as where this system wins. Hosted, that sentence
  is false, and the competitor becomes the subscription POS it was written against. The
  answer is not technical: it is what we promise about data, export and uptime.

## Known gaps, stated rather than discovered

- **There is no high availability, and now it matters to every shop at once.** A reboot is
  downtime; before this, it was one shop's downtime.
- **PDPA is unsolved and is not code.** Customers' phone numbers and every shop's sales
  move onto our hardware: consent, retention, who may look, and a data-processing
  agreement are decisions nobody has made yet. A Thai shop will ask before it pays.
- **The connection pool and the migration loop are unbudgeted here.** They are phases in
  `docs/hosted-release-plan.md`, not footnotes: neither is hard, and both are the kind of
  thing that is discovered at fifty shops rather than at three.
- **Nothing of this exists yet.** Until it does, the code in this checkout *is*
  one-shop-per-deployment, and the documents that describe that (README, the gap analysis
  §1, the onboarding §1–2) are still true. This ADR is the direction, not a description of
  the product — and the plan says which document changes at which phase.
