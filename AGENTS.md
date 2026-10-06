# Working in this repo as an agent

Orientation for an agent picking this up cold. The **README** is the product
document, the **ADRs** are the decisions, and `system_requirements_document.md`
is the spec this implements. This file is only the part that is easy to get wrong
from the outside: how to run it, what will get a change sent back, and the traps
that have already cost real hours here.

Read this file, then `README.md`, then the ADR that touches what you are
about to change. The brand's concept — where the name เหลี่ยมนอก comes from and
the rules every screen inherits from it — lives in `docs/brand.md`.
**Do not restate or duplicate those documents** — if you learn something
new and durable, put it in the file that owns it.

---

## Agent skills

### Issue tracker

Local Markdown, one ticket per file under `.scratch/<feature>/issues/`.
See `docs/agents/issue-tracker.md`.

### Triage labels

Standard skill vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context glossary and ADRs. See `docs/agents/domain.md`.

## Who maintains this

**The agent working in this repo is the one who develops and maintains this system.**
Not a helper a developer calls in for a patch, and not a single session: the owner
reads this same checkout, and each round of work starts cold with nothing carried over
except what the repository says. Every document here is written for that reader — which
is why an undocumented decision is a decision the next round re-litigates, and why a
stale claim is worse than a missing one.

Maintaining rather than patching is four obligations, and they are the rest of this
file in summary:

1. **The repository is the memory.** A durable decision goes into an ADR — numbered,
   with the alternative it rejected and the gaps it knowingly left — and a behaviour
   that changed goes into the file that owns it, in the same commit. A claim that stops
   being true is *deleted*, and nothing catches it for you: the README kept *an
   audit-log viewer* on its not-built list for the twenty commits after `/admin/audit`
   shipped, and `docs/renter-onboarding.md` still refused a partial refund in writing
   two ADRs after a partial refund worked. `npm run doc:audit` is the one gate that does
   read a document, and only the command lists: a script no document runs, or a
   document running a command that does not exist. Neither example above is that, which
   is why both needed a person.
2. **"Green" is a measurement, not a belief.** `npm run verify:all` runs every gate in
   dependency order, and the numbers come out of that output — never out of a document.
   The counts in `README.md` have drifted twice from being quoted rather than run.
3. **The shop's documents are part of the system.** `README.md` is the product
   document; `docs/renter-onboarding.md` is the operator's runbook — plain English prose
   wrapped around the Thai labels a counter actually sees — for the person installing
   the shop and then running it; `docs/homelab-deploy.md` is how the shop's own box
   keeps working across a reboot, and the units under `deploy/systemd/` are the
   deployment rather than an example of one. A new button, a new refusal, a new
   command, or a thing this version stops doing is a change to those too.
4. **Commits are the trail** — the message says *why* the change is right rather than
   what moved. Commits land on `main` in this checkout; the owner decides what goes to
   `origin`, and nothing is pushed, merged or deployed on your own initiative.

### Where it stands

Recorded so a session starts from the truth rather than from the last commit message.

- **Everything the SRS specifies is implemented and verified** — §1 to §8, mapped to
  code in README's *How the SRS maps onto the code*.
- **Beyond the spec**, because a shop needs it: a call number on every walk-in bill,
  printed as the loudest thing on the receipt, with a state machine the bar taps through
  and the number called on the customer screen (ADRs 0017, 0018); VAT with gapless
  tax-invoice numbering
  (ADR 0002), credit notes and per-line refunds (ADRs 0004, 0008), a transfer that
  closes its own bill from the shop's own bank notification with no payment provider
  (ADR 0005), customer accounts created at the counter (ADRs 0010, 0011), a notification
  outbox the shop runs (ADR 0007), a pickup code the counter scans (ADR 0006), and a
  limiter on the doors worth guessing at, whose buckets are shared between processes
  (ADRs 0009, 0012).
- **A pasted image link is read in one place** (ADR 0014, amended): a product photo and
  the shop logo both go through `renderableImageUrl`, which also reads a Nextcloud
  public share link as the picture inside it — the share link itself answers
  `text/html`, `/preview` beside it answers `image/png`. The shop logo was settable only
  from a database client until now — `/admin/settings` sent `logo_url` with every save
  and showed nothing to type it into.
- **The customer screen has rules of its own** (ADR 0018): which stage is showing is
  one pure decision (`src/components/display/display-stage.ts`) rather than five
  conditions kept in step by hand, the bill sits beside the payment QR, and a receipt
  link mirrored onto it is cleared when the sheet closes — one customer's QR is not the
  next one's to scan.
- **The fonts are Inter (Latin) and Mitr (Thai)**, self-hosted through `next/font`; the
  receipt drawn to a canvas follows `--font-thai` because a canvas cannot read a CSS
  variable.
- **`npm run server:check` exists because the expensive failure was not in the code.** A
  server left over from before a rebuild serves HTML whose asset files no longer exist,
  which on screen reads exactly like a bug in the change just made, and cost more than one
  round of "the fix did not work" before anyone measured it.
- **Deliberately not built**: README's *Not built yet* — overtime approval and leave,
  LINE addresses for customers, multiple branches, a second register, **storing** a
  product image (a photo is a link now — ADR 0014), RTL, object storage, and a
  reconciliation over a date range rather than a day.
- **Not yet proven, and this is the honest half.** No shop has run this. There is no
  field pilot; Chromium now exercises the offline flow in CI, but the
  restore in `docs/homelab-deploy.md` §7 is a recipe that no script, check or CI job
  rehearses, nothing has ever loaded `deploy/systemd/` — those units were reviewed by
  reading, never by `systemd-analyze verify` or a real boot — there is no
  experience of real data volume in reports or analytics. **Actual IndexedDB and
  the cashier outage/replay flow are now tested** by `scripts/offline-browser.ts`;
  Playwright is an explicitly approved dev-only dependency, not a fake database.
  Hardware power loss, browser eviction and physical printer behavior remain
  unmeasured. "Green" means *correct as far as the tests reach*, not shop field use.

---

## What this is

A single-shop, Thai-first point of sale: realtime, with atomic inventory
reservation, a four-phase pre-order lifecycle, RBAC, cash-drawer reconciliation,
VAT receipts and SRS §8 Excel exports. One process serves everything — Next 16
App Router, PostgreSQL 17 through Prisma 7, and Socket.io attached to the same
`http.Server` so the session cookie authenticates both the pages and the
websocket (`src/server.ts`).

Three authenticated areas and three public surfaces:

| Area | Prefix | Screens |
| --- | --- | --- |
| Manager | `/admin/*` | dashboard, products, audit, reports, schedules, settings, staff, customers |
| Till | `/pos/*` | the register, the drink queue, attendance, pre-orders |
| Customer | `/shop/*` | catalogue, orders |
| Public | — | `/login` (the customer's door; staff fold in behind it), `/setup` (first run), `/display` (customer screen) |

---

## Using it

`docs/renter-onboarding.md` is the operator's guide: Thai, written for the person
behind the counter, from install to the first sale and the daily routine. Read it before
changing anything a counter sees — staying true is its whole job.

From this side the useful question is a different one: how do you *see* a change? On a
throwaway database, `npm run db:setup:demo` and then `npm run dev` — or the production
build, which is what to verify against (see Traps) — and sign in as one of the seed's
personas (README §3): the **admin** for anything involving money or people, the
**employee** for the counter, the **member** for the pre-order side. `/display` is the
customer-facing screen, paired from `/admin/settings`.

Three loops cover the product:

1. **A sale.** Open a drawer first (`เปิดลิ้นชัก`) — a sale is refused without an open
   shift, because cash that belongs to no drawer cannot be reconciled. Scan or tap a
   product; attach a customer with `ค้นหา` by phone, or `สมัครสมาชิกใหม่` to enrol one
   without leaving the bill (ADR 0011). Take cash, PromptPay or a split, then close and
   print. `คืนเงินบิลนี้` on the receipt reverses it, wholly or a line at a time.
2. **A pre-order.** The customer orders from `/shop/products`, which **reserves the
   stock the moment it is placed**; staff accept it, pack it — which mints the 4-digit
   PIN and the hold deadline — and hand it over at `/pos/preorders` by scanning the QR
   or typing the PIN or the phone number.
3. **The manager's day.** `/admin/dashboard` reconciles today, confirming the bank's
   transfers against the bills they closed; `/admin/products` carries the CSV/XLSX
   import; `/admin/members` the customers; `/admin/reports` the four workbooks; and
   `/admin/audit` every gated action with the name of whoever approved it.

Two things stop a newcomer, and both are deliberate. An unconfigured deployment sends
`/login` to `/setup`, and **no supervisor PIN is set by the seed**: until one is set at
`/admin/staff`, an over-limit discount and every refund are refused — including for the
owner.

---

## Commands

| Command | What it does | Needs |
| --- | --- | --- |
| `npm run setup` | Writes `.env`, creates the role and both databases, migrates. Idempotent. | Postgres superuser prompt |
| `npm run dev` | `src/server.ts` in dev mode: Next + Socket.io on one port. | — |
| `npm run build` / `npm run start` | Production build, then the same custom server. | — |
| `npm run verify` | `typecheck` → `ui:audit` → `doc:audit` → palette-up-to-date → `test`. **This is the gate.** | — |
| `npm run verify:all` | That gate, then `acceptance` → `route:audit` → `limiter:race` → `offline:browser`, stopping at first failure. One production build reused; matches CI. | Postgres + Chromium |
| `npm run offline:browser` | Actual Chromium/IndexedDB offline cash, replay/reconnect and recovery on a test-only scratch schema; `-- --skip-build` reuses the build. Install with `npx playwright install chromium`. | TEST_DATABASE_URL + Chromium |
| `npm test` | Vitest: unit + integration against real Postgres. | `TEST_DATABASE_URL` |
| `npm run ui:audit` | Fails if the retired theme reappears in `src/`. | — |
| `npm run doc:audit` | Fails if `package.json` defines a script no document runs, or a document runs a command that does not exist (ADR 0013). | — |
| `npm run route:audit` | Builds, serves, and checks that every screen renders a page whose CSS defines every class on it (25 today, 28 requests). | Postgres |
| `npm run server:check` | Probes a **running** server and fails if it is not serving this checkout's build. `-- --url <base>`, `-- --verbose`. | A running server |
| `npm run brand:palette` | Regenerates the colour ramp. `-- --check` fails if stale. | — |
| `npm run brand:icons` | Resamples `public/brand-mark.png` into the app icons. `-- --preview` prints them as text. | — |
| `npm run db:generate` | Regenerates the Prisma client after a schema change — **and commit it**. | — |
| `npm run db:seed:demo` | Seeds demo data. Refuses unless the shop is unconfigured. | Throwaway DB |
| `npm run smoke` | End-to-end checks over real HTTP. | A running server |
| `npm run acceptance` | The whole renter journey from an empty schema, including a refund and a bank notification; serves the production build itself. | Postgres |
| `npm run limiter:race` | Starts **two** servers on one scratch schema, signs the same cashier in at both, and races them at one rated door — the proof that the shared buckets (ADR 0012) are one limit rather than one each. `-- --skip-build`, `-- --keep`. | Postgres |
| `npm run bank:bridge` | Reads the shop's own bank notification mailbox and posts what it finds to the app. `-- --file <eml>` parses a saved one and prints what it would post. | An IMAP mailbox, or none with `--file` |
| `npm run backup` | One compressed `pg_dump` of the shop's database, then a prune of what aged out. Watched by `deploy/systemd/pos-backup.timer`; `-- --list`, `-- --dir`, `-- --keep`. | `pg_dump` on PATH |

The table stops at what a shop or a renter runs. The maintenance loop is the rest:
`npm run db:migrate` is `prisma migrate dev` and belongs on a development machine
only — the box runs `npm run db:deploy`; `npm run db:studio` opens Prisma Studio; and
`npm run db:test:prepare` builds the schema `TEST_DATABASE_URL` points at, which is
what `npm run db:setup` calls. The suite has two slices for the inner loop, `npm run
test:unit` (the pure money and state machines) and `npm run test:integration` (real
Postgres), plus `npm run test:watch`. They are written down because `npm run doc:audit`
fails when a script is named by no document — which is also what keeps these two lists
from drifting apart.

---

## Rules a change has to satisfy

These are not style preferences. Each one exists because the alternative was
tried and hurt, and several are enforced by a test or a check.

1. **UI comes from `src/components/ds/`.** Never a Bootstrap class, a
   `data-bs-*` attribute, or a `/hope-ui/` path — the vendored theme was deleted
   and `npm run ui:audit` fails the build if any of them come back. Inside a
   literal `className`, the only project class is an `ln-*` utility (plus `dark`,
   the theme class the root layout puts on `<body>`). Everything else comes from
   a CSS module.
2. **Do not add a dependency for something small.** There is no UI framework, no
   Tailwind, no icon package, no chart library, and no HTTP client. Icons are one
   file of path data; the dashboard's chart is our own SVG; the CSV parser and the
   THB formatter are hand-rolled. Check what is already installed before
   reaching for npm.
3. **Forms get wired, not just styled.** Every control needs an `id`, a matching
   `<label for>`, and an `aria-describedby` for its help or its error. Use
   `TextField`/`SelectField`/`ToggleField`, which do it for you. `outline: none`
   appears nowhere; every control is at least `--ln-tap` tall.
4. **Sizes come from the density tokens, never from a hardcoded pixel value.**
   The shell sets `data-density` once per area — `touch` for the till, `compact`
   for the back office — so the same `<Button size="md">` is a 34px control on
   `/admin` and a 48px target on `/pos`. A screen that writes its own height
   breaks that.
5. **Semantic tokens only, never a raw colour.** Components reference
   `--ln-brand`, not `--ln-brand-600`; `--ln-brand-600` is a colour while
   `--ln-brand` is a decision, and dark mode changes the decision without
   touching a component. `tests/contrast.test.ts` asserts the pairs stay legible.
6. **User-facing copy is Thai.** Comments, commit messages, identifiers and log
   lines are English. A refusal a user reads (a 403, a validation error) is Thai
   and says what they can do; a programming mistake is English and is a 500.
7. **Pure logic and persistence stay in separate modules.** State machines,
   pricing and the loyalty/discount maths are pure functions in `src/lib/*-rules`
   or alongside their domain; the database lives in a separate module. That split
   is why the money rules can be checked without a running server — do not quote a
   test count here, it drifts; `npm test` prints it.
8. **Every route handler funnels through `withApi` and stamps its own
   authorisation.** The role always comes from the signed session token, never
   from a request body. `src/proxy.ts` decides which *area* an unauthenticated
   visitor may look at; it is not the authorisation — `requireRole` in the
   handler is, plus `requireShellUser` in each layout.
9. **Comments explain why, and are dense on purpose.** If a comment states what
   the code plainly does, it will be deleted in review. If it records the
   alternative that was rejected, the measurement behind a magic number, or a
   failure mode, it is the point of the file.
10. **Times are Bangkok's, not the server's.** Calendar days, "today", roster
    windows and report ranges go through `src/lib/bangkok-time.ts`. A date that
    means a different day depending on where the process runs is a bug that only
    shows up on someone else's machine.

---

## Invariants the database enforces

Do not weaken these to make a feature easier; they are the ones carrying the
weight. They are checked in `prisma/schema.prisma` and asserted by the suite.

- **Never oversell.** Stock moves through one conditional `UPDATE` per mutation
  (`src/lib/inventory.ts`), so 50 concurrent reservations against 20 units leave
  exactly 20 succeeded, 30 rejected with 409, and `reserved_qty` at 20.
- **`CHECK (net_amount + vat_amount = final_amount)`** — a tax receipt whose lines
  do not add up is refused by the database, not by a code review.
- **`CHECK (id = 1)` on `shops`** — the singleton is a fact, so a racing second
  setup cannot win one.
- **`audit_logs` refuses UPDATE and DELETE.** The trail has no writer for either,
  by design: "who approved this" has to survive being asked months later.
- **One open time log per employee**, enforced by a unique index, not only by the
  application guard.
- **Money is `DECIMAL(10,2)`; tax arithmetic is done in integer satang**
  (`src/lib/vat.ts`). A breakdown off by one satang is a document that does not
  balance, not a rounding nit.
- **Call numbers restart every Bangkok day and never repeat inside one.**
  `orders.queue_number` + `queue_day` are a pair with a unique index, so two bills
  sharing a number is refused by the database rather than only by the allocation
  being careful; the counter on the shop row resets in the same `UPDATE … RETURNING`
  that bumps it, so a rolled-back sale burns no number. The day is stored, never
  derived from `created_at` (ADR 0017).
- **Receipt numbers are gapless and un-reusable**, serialised on the shop row.
  Credit notes have their own gapless series (`shops.credit_note_running_number`),
  allocated in the same transaction, so a refund that is refused burns no number
  and a credit note never consumes a receipt number.
- **A series a device is holding numbers from cannot be allocated from at all**
  (`number_blocks`, ADR 0019). A device that may lose its connection borrows a range
  in advance, and while a block is open the shop's series is **frozen**: the condition
  travels inside the same `UPDATE` that allocates, and the partial unique indexes are
  the same predicate. Reporting a block sets the counter back to the last number
  actually printed — which is what keeps the series gapless — and cancelling one puts
  it back before the range. At most one open block per series, and one per day for
  call numbers. A device that holds numbers is the allocator for its own bills, online
  sales included: a number issued *beside* a borrowed range could never be placed in
  the series afterwards. So the walk-in sale takes the device's own number
  (`deviceNumbers`) and `claimNumberFromBlock` judges it — open loan, inside the range,
  and **exactly next for invoices** (strictly past the mark for call numbers): a
  number at or below the deepest one the loan has
  recorded is two customers and one ticket, which is why that refusal is a 409 and
  not a `ValidationError`.
- **`payments.amount` is always positive**, and `payments.direction`
  (`sale`/`refund`) carries the sign. `CHECK (amount > 0)` therefore still holds
  for a refund leg — so every aggregate over `payments` must say what it means:
  drawer cash nets refunds, gross takings do not, and a report's payment-method
  column filters `direction = 'sale'`. A sum that forgot `direction` is the bug
  this column exists to make visible.
- **`CHECK ((direction = 'refund') = (credit_note_id IS NOT NULL))` on
  `payments`** — money cannot leave without a document behind it, and an ordinary
  sale cannot claim a credit note.
- **`UNIQUE (order_id, sequence)` on `credit_notes`** — a bill takes several notes
  now (ADR 0008), numbered within it, and `credit_note_items` is unique per line per
  note so one line cannot be returned twice on one document. `refunded` is a
  terminal order status (`src/lib/order-state.ts`), and the only edge into it is
  `refund` out of `completed`; a **partial** refund leaves the bill `completed`.
- **What a bill still owes is the sum of its notes, never a column.**
  `credit_notes.gross_amount − discount_amount = final_amount` is a CHECK, the
  order's own totals are never rewritten, and the note that empties the order takes
  the remainder (ADR 0008) so the notes foot to the invoice to the satang. The
  arithmetic is pure and tested in `src/lib/refund-plan.ts`; the till previews with
  the same function the route writes with.
- **`inbound_payments` is only half of a transfer.** The other half is the
  `payment_intents` row that closed a bill, and the only way to see the day as a
  whole is to compare them (`src/lib/inbound-reconcile.ts`). A change to either
  status machine changes that comparison.
- **`UNIQUE (source, external_id)` on `inbound_payments`** — the same bank message
  is recorded once, so a retrying bridge cannot double-count money. `external_id`
  is the bank's own `Message-ID`, falling back to the mailbox UID.
- **`inbound_payments.amount` is null if and only if the reason is
  `amount_unreadable`** — a notification whose figure could not be read is kept
  with no amount rather than with a made-up one. Never write a placeholder number
  into that column to satisfy a `NOT NULL`; the pairing is the contract.
- **`CHECK ((direction = 'refund') = (credit_note_id IS NOT NULL))` on
  `payments`** (repeated here because it is the one that reads oddly): a refund
  leg must name a credit note, and a sale leg must not.
- **`users.phone` is unique across every role, and normalised before it is
  compared** (`src/lib/phone.ts`). A customer account cannot take a cashier's
  number, and `080-000-0002` and `0800000002` are one account — which is what keeps
  the till's phone lookup working. Role is decided by the *surface* that writes the
  row (`members.ts`, `staff.ts`), never by a request body, and each refuses the
  other's accounts.
- **The rate limiter's buckets are rows in the shop's own database**
  (`rate_limit_buckets`, ADR 0012), so a restart forgets nothing and two processes
  enforce one limit between them. Spending one is an `ON CONFLICT DO UPDATE` that
  takes a row lock — never a `SELECT … FOR UPDATE`, which finds nothing to lock the
  first time — and both the decision and the row use the *database's* `now()`, the
  only clock several processes agree on. The arithmetic stays in the pure module;
  do not express the refill in SQL, or the numbers get a second home. A key is
  truncated to `MAX_BUCKET_KEY_LENGTH` because it is a primary key, and an
  unreachable store lets the caller through (ADR 0012 decision 5).
  `npm run limiter:race` is what proves the sharing across two real server
  processes — do not move the buckets back into the process. The policy is
  keyed by the address the *socket* reports; `X-Forwarded-For` is believed only
  when that address is private. `src/server.ts` stamps `x-client-address` and overwrites
  whatever the caller sent — never trust an inbound copy. Only the first refusal of
  a burst is audited (`rate_limited`), because some of these doors are reachable
  without a session and a row per refusal would be a free way to fill the trail.
  The policies are the session-less doors plus one signed-in write,
  `member_create`, which is keyed by the *account* rather than the address so two
  cashiers on one wifi are two budgets (ADR 0011 §6).

---

## Verification: what "green" means

`npm run verify` must pass, and it is not optional: `typecheck` + `ui:audit` +
`doc:audit` + `brand:palette --check` + `test`. If you changed the schema,
regenerate and commit `src/generated/prisma/` (it is tracked; the
`/generated/prisma` line in `.gitignore` is a different path). If you changed an
anchor colour, run `npm run brand:palette` and commit `src/design/tokens.css`.

Then, for anything a person will look at:

- `npm run build` and check the route list — a new page that fails to build is
  usually a server component importing a client-only module.
- For UI work, look at the rendered page, not only at the diff. **A missing
  stylesheet is silent**: the markup still compiles and the screen merely renders
  unstyled. That is exactly how the theme removal once went wrong here, which is
  why `ui:audit` (no retired vocabulary in the source) and `npm run route:audit`
  (every rendered class defined in the CSS that page loads) both exist.
- `npm run acceptance` when you have touched the root layout, the proxy, roles,
  the sale path or anything a renter meets on first run. It builds, serves on a
  scratch schema, and drives the whole journey.

**CI runs all of it** (`.github/workflows/verify.yml`): `verify` in one job, then
`acceptance` + `route:audit --skip-build` + `limiter:race --skip-build` +
`offline:browser --skip-build` in a second,
each with a PostgreSQL 17 service. Node is pinned by `.nvmrc` and `engines.node`, so
the version the suite runs on is the version a renter is told to install.

Locally the same thing is **one command**, `npm run verify:all`: it runs those five in
dependency order — nothing is built for the first, the journey builds once, and the
last three walk the artefact it produced — and stops at the first failure, because every
later gate would be measuring a commit that is already known to be broken. It is the
release check; `verify` alone is the inner loop. The two jobs and this command are
deliberately the same set, so CI cannot go green on something this does not run.

---

## Traps

### The browser sandbox cannot always reach your server

This has bitten every round of UI verification. In order of preference:

1. **Verify against the production build, never the dev server.** In dev mode
   (`npm run dev`), Next refuses to hydrate a page loaded from a non-localhost
   origin: every chunk returns 200, the HMR socket dies with
   `ERR_INVALID_HTTP_RESPONSE`, and clicks do nothing. Run `npm run build`, then
   `npm run start` with `HOSTNAME`/`PORT` from the environment, and point the
   browser at the host's LAN or Tailscale address.
2. **The sandboxed browser may not reach the host at all** — loopback, the LAN
   IP, the Tailscale IP and `host.docker.internal` can all fail with
   `chrome-error` while the public internet loads fine. When that happens, run
   `npm run route:audit`: it fetches each route from the built
   server, collects the stylesheets each one links, and asserts that every class
   in the HTML is defined in that CSS. Do not re-write that check by hand — the
   first hand-written version is what caught the vendored theme's Google Fonts
   `@import`, which the "fonts are self-hosted" fix had not actually removed.
3. **A production session cookie is `Secure`, and a *minted* token opens the API but
   not a page.** Measured on a production build: a token from `createSessionToken()`
   (`src/lib/session-token.ts`) set as `pos_session` answers `/api/v1/…` with 200 and
   every *page* with a 307 to `/login` — the proxy runs in a different runtime from the
   route handlers, which is the only place the difference can come from. So mint for
   `curl` and for API work, and to drive pages log in through `POST /api/v1/auth/login`
   with `{ "identifier": "0800000001", "password": … }` — it is `identifier`, not
   `phone` — keeping the cookie jar. Cookies ignore the port, so one login at `:3106`
   also authenticates `:3107`, which is what makes several scratch servers cheap.
4. **Screenshots need a composited tab.** Read values from the DOM
   (`getComputedStyle`, geometry) instead, and use an explicit tab id — the
   preview tools follow the *active* tab otherwise. CSS transitions read as their
   start value in a non-composited tab, so disable them before judging a
   transition.

### Windows

- **Thai text passed through `curl -d` on the command line is re-encoded into
  `?`** by the console codepage; the request then fails validation and looks like
  a server bug. A body written to a file by a quoted heredoc and sent with
  `--data-binary @file` preserves UTF-8. `scripts/acceptance.ts` is a Node script
  for this reason.
- **Prisma's `?schema=` is honoured by Prisma and ignored by `pg`.** A raw `pg`
  connection built from the same `DATABASE_URL` silently queries `public`, so
  qualify the schema (`select … from ui_check.shops`) or set `search_path`.
- `TEST_DATABASE_URL` must contain `test`. The suite truncates tables and refuses
  to run otherwise.

### Git

The `origin` remote fetches over SSH and pushes over HTTPS, because SSH is not
authorised on this machine (the local `~/.ssh/id_ed25519` is not registered on
GitHub) while a cached HTTPS credential is. Add the key to GitHub and
`git remote set-url --push origin git@github.com:TanatPinkeaw/POS.git` to make
both halves SSH again. Until then `git fetch origin` fails outright — its last line,
`and the repository exists.`, reads like a missing repository and is not — so read the
remote with `git ls-remote https://github.com/TanatPinkeaw/POS.git refs/heads/main`.
A push over HTTPS works and updates `origin/main` locally, so `git status -sb` is
trustworthy straight after one.

---

## Where to pick up

The design-system migration is **finished**, and so is the money work that followed
it: a paid bill can be reversed wholly or one line at a time, with a credit note
behind every note (ADRs 0004, 0008), the five doors that need no session count
attempts and refuse a burst (ADR 0009), an incoming transfer can close its own bill
from the shop's own bank notification with
no payment provider (ADR 0005), a pre-order is handed over with either a scanned QR
or the PIN beside it (ADR 0006), and the messages that used to need somebody
watching a screen are queued with the fact that produced them and sent by a worker
the shop runs (ADR 0007). Every route is on `src/components/ds/`,
the vendored Hope UI theme is deleted, `ui:audit` keeps it that way, `route:audit`
walks every screen, and `acceptance` drives the renter journey **including a
refund, a machine-confirmed transfer and a pre-order collected by code** — all in
CI. The test count lives in `README.md` and in the `verify` output; do not quote it
from here, it drifts.

Two shapes to copy when adding to either path, because both are the reason the
money logic is trustworthy: the *decision* is a pure module with typed refusals
(`order-state.ts`, `inbound-match.ts`, `pickup-scan.ts`) and the *record* is a
persistence module tested against real Postgres (`credit-notes.ts`,
`inbound-payments.ts`).

One trap worth knowing before you write a refusal: **an error that is not a
`DomainError` becomes a 500.** `withApi` maps `DomainError` onto HTTP and flattens
everything else to "something went wrong on our side" — so a stale QR reached the
cashier as an alarm until `InvalidPickupTokenError` was given the base class. Both
versions type-check and both refuse the request; only one is readable at a counter.

Open threads, roughly in the order worth doing:

1. **A restore that a machine rehearses.** §7 of `docs/homelab-deploy.md` is a recipe
   performed by hand, and nothing runs it — so the one procedure a shop needs to have
   worked before it needs it is the one with no measurement behind it. Restoring last
   night's dump into a scratch schema and counting the rows would move it off the
   *Where it stands* gap list, and belongs in `verify:all` beside the other gates that
   start a server.
2. **A reconciliation over a range.** The dashboard reconciles today — confirmed
   transfers against the bills they closed, plus what is waiting — but a statement
   covering a week is still compared by hand.
3. **Customer messages on LINE.** Delivery works (ADR 0007); the *address* does
   not. A LINE push needs a LINE user id, this system stores only phone numbers,
   and asking members for one is a consent decision before it is a schema change.
   Until then `line` means the shop's own group, and customers get SMS or a
   webhook.
4. **A `/design` reference route** that renders every primitive with its tokens,
   so the library is visible in one place rather than inferred from call sites.
5. **A command that prints where this checkout stands** — branch, how much of it is
   unpushed, and the last gate's numbers — so the round after this one starts from a
   measurement instead of a remembered one. `npm run server:check` answered the
   *adjacent* question (is the process on this port serving this checkout's build);
   this one is still reconstructed by four commands typed from memory.

Known product gaps are listed at the end of `README.md` (overtime approval, LINE
addresses for customers, multiple branches, product images, RTL, object storage).
