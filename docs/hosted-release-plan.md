# Releasing this as a hosted rental — the plan

**What this file is.** The order of work for turning this repository into what ADR 0016
decided: a shop signs up with Google and gets its own space on a box we run. The ADR owns
*why* it is shaped that way and what it costs; this file owns *what happens in what order*,
what "done" means for each step, and which document has to change with it.

**What has to be true before any of it starts:** ADR 0016 is accepted, and the three
decisions it leaves open are made — the tenancy model and the seam (decided), the identity
split (decided: Google for the owner, phone and password for the shop's staff), and what
happens to a shop that stops paying (not decided — see §5).

**Nothing in here is built yet.** The commands this plan names for later steps
(`doctor`, `restore`, `upgrade`) are written **without** the `npm run` prefix on purpose:
`npm run doc:audit` (ADR 0013) fails a document that runs a command which does not exist,
and that gate is right — a plan that reads like a runbook is exactly the drift it was built
to catch. When a command ships, its name here gains the prefix in the same commit.

---

## 0. The bar: "easy" written down as a customer's ten minutes

The whole point of hosting is that nothing gets installed by the shop. The target, and the
thing every phase below is judged against, is this path with no terminal in it:

1. Go to the site, **continue with Google**, name the shop.
2. Answer the wizard's three questions (shop, tax and receipt, the first administrator).
3. Add staff, import a catalogue from a spreadsheet, print one test receipt.
4. Pair the customer display, set the supervisor PIN, and start trading.

If a step needs a terminal, a file edit or a support message, it is not done.

---

## 1. Where we start (measured on this checkout, not assumed)

| | Today | What it means here |
| --- | --- | --- |
| Tenant key | 21 models, **zero** `shopId` columns | Tenancy is not a column; it is a schema (ADR 0016 §1) |
| `shops` | `id @default(1)` + `CHECK (id = 1)` | Stays literally true *inside* each shop's schema |
| `src/lib/db.ts` | builds the client from `DATABASE_URL`, honours and validates `?schema=` | The per-shop seam already exists and is already exercised by the suite |
| Callers | **40 files** import the single `prisma` | The seam must be invisible to them, or this is a rewrite |
| Realtime | one socket server; `EVERYONE_ROOM`, `DISPLAY_ROOM`, `user:<id>` are global | Rooms become per shop, and a room name without a shop is a cross-shop leak |
| Session | `sub`, `role`, `fullName`, `phone` — no shop | The token (or the host) has to name the shop |
| Workers | `notify-worker` and `bank-bridge` assume one shop per process | They become loops over shops |
| Raw `pg` | one place, `scripts/harness.ts` | The `?schema=` trap (Prisma honours it, `pg` ignores it) has one site to fix, not twenty |

---

## 2. The phases

Each phase ends somewhere usable, so the work can stop after any of them without leaving
the repository in a state that lies about itself.

### Phase 0 — the decisions, in writing

Write ADR 0016 (done), plus the two ADRs it defers: what the shop's own login looks like
once an owner can sign up, and what a lapsed subscription does. No code.

**Done when:** the ADRs exist, and no phase below depends on a question that has no answer.

### Phase 1 — accounts, tenants, and the door

The control plane (`accounts`, `tenants`) and the signup flow: Google's authorization code
with PKCE, a slug per shop, and a tenant resolved from the host.

**Done when:** somebody can sign up with a Google account, be given a slug, and land on a
page that names a shop which does not exist yet — and a second signup cannot take the first
one's slug.

**Decide inside this phase:** how the Google identity is verified. **Decided by ADR 0020:
verify the id token here, against Google's JWKS with RS256** (`jose`, already a dependency),
rather than calling Google's `tokeninfo` endpoint — the network round trip per sign-in and
the coupling to Google's rate limits are not worth avoiding crypto we already have. The one
option that is not open is trusting an unverified token because it arrived over TLS.

**Identity is now split three ways (ADR 0020, which amends ADR 0016 §4).** Google is the
owner's **signup** door and the **customer's** sign-in door; the shop's staff and the owner's
day-to-day use keep the phone and temporary password the counter already runs. A customer's
phone stays unique across every role and is what their points hang off, and a first Google
sign-in makes a customer only for a number nobody owns — a number that already holds a row is
refused rather than linked, because a typed number proves nothing (ADR 0020 §4).

### Phase 2 — provisioning: signing up creates a shop

`CREATE SCHEMA` plus the migrations, applied to a brand-new schema, idempotently and with a
retry — because a half-created shop is worse than a failed signup. A tenant status of
`active` or `suspended`.

**Done when:** a fresh signup yields an empty shop that the wizard can take over, and
running the same step twice changes nothing (the same property `npm run setup` has today,
for the same reason: "try again" must always be safe advice).

### Phase 3 — one process, many shops

The runtime seam: a client per shop held in `AsyncLocalStorage`, resolved from the host; the
socket rooms namespaced per shop; the notify worker and the bank bridge looping over shops;
display pairing scoped to a shop. The client cache gets an eviction policy and a per-shop
connection budget, because `max: 10` per client is not a number that survives fifty shops.

**Done when:** two shops run in one process with their own sessions, their own socket rooms
and their own workers, and a request with no shop **throws** rather than reaching a default
client (ADR 0016 §3).

### Phase 4 — proving the wall is real

The tests that make the isolation a claim rather than a hope: two shops in one database
cannot see each other's products, bills, customers or notifications; a request that loses
its tenant fails; an acceptance run does signup → wizard → sale → pre-order for two shops
side by side, including one shop's receipt numbering being unaffected by the other's.

**Done when:** `npm run acceptance` covers both shops, and the tenant-isolation tests fail
if the seam is pointed at a default client.

### Phase 5 — ops for a fleet

One migration command that walks every schema; a backup per shop and a restore per shop
(this is also how a shop leaves with its data); a tenant lifecycle (create, suspend, export,
delete) with the deletion path written down rather than improvised; and the restore drill
that today's docs admit has never been rehearsed.

**Done when:** a shop's data can be exported to a file, restored from it into an empty
schema, and deleted — all three run against a real shop, not a fixture.

### Phase 6 — the money

Plans, invoices, and what happens when a shop stops paying. The system already has the
machinery this needs — inbound payments matched against what closed a bill, and a
reconciliation that calls out money which closed nothing (ADR 0005) — and a Thai shop pays
by transfer or PromptPay, not by card.

**Decide inside this phase:** the lapse policy. A till that stops mid-service is a worse
failure than an unpaid invoice; the honest shape is read-only after a long grace period,
with the data always exportable and never held hostage.

### Phase 7 — hosting it for real

Wildcard TLS and per-shop hostnames, a machine that comes back after a reboot, monitoring
that notices a dead worker without somebody running `systemctl status` — and an honest
answer about availability, because there is no failover anywhere in this design and now the
uptime of every shop rests on it.

**Done when:** a shop's signup, sale and restore all work on the box that actually serves
shops, and the answer to "what happens when it reboots?" is written down.

---

## 3. Which document changes when

| Phase | Document | Change |
| --- | --- | --- |
| 0–1 | `README.md` | *Not built yet* gains the hosted rental, pointing at ADR 0016 and this file |
| 2 | `docs/renter-onboarding.md` | Loses §1–2 (Node, PostgreSQL, the installer): a shop no longer installs anything |
| 2 | this file | Each planned command that ships gains its `npm run` prefix, in the same commit |
| 3 | `docs/homelab-deploy.md` | Stops addressing a renter and starts addressing whoever runs our box |
| 5 | `docs/wongnai-pos-gap-analysis.md` | §1's positioning paragraph, which currently claims self-hosting as the win |
| 7 | `docs/homelab-deploy.md` §10 | The "what this does not cover" list, once the hosted answer to it exists |

The rule for all of them is the repository's own: a claim that stops being true is deleted,
in the commit that made it untrue.

---

## 4. Deliberately not doing (so it is one decision, not a drift)

- **A shop's own database.** A later upsell, and cheap to add because the seam is the same
  one (ADR 0016 §1).
- **Several branches or a second register per shop.** Unchanged from README's *Not built
  yet*; a second till is a change to the money path, not a second container.
- **A licence key or an activation gate in the code.** The subscription is an account
  state, enforced where the shop is hosted, not a lock inside software somebody runs.
- **Docker, Kubernetes, multi-region.** The systemd units are the maintained path and this
  plan does not add a second one.
- **A public API, webhooks for shops, or an app store presence.**

## 5. The two blockers that are not code

1. **PDPA posture.** Every shop's customers' phone numbers and every sale move onto our
   hardware. Consent, retention, who may look, breach notification and a data-processing
   agreement are unanswered, and no amount of Phase 3 answers them.
2. **The positioning flip.** The gap analysis's winning argument was self-hosting. Hosted,
   the product has to win on something else — and the honest candidates are already in this
   repository: stock truth, the pre-order lifecycle, and a refund and tax story that is
   correct by construction rather than by convention.
