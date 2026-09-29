# Working in this repo as an agent

Orientation for an agent picking this up cold. The **README** is the product
document, the **ADRs** are the decisions, and `system_requirements_document.md`
is the spec this implements. This file is only the part that is easy to get wrong
from the outside: how to run it, what will get a change sent back, and the traps
that have already cost real hours here.

Read this file, then `README.md`, then the ADR that touches what you are about to
change. **Do not restate or duplicate those documents** — if you learn something
new and durable, put it in the file that owns it.

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
| Manager | `/admin/*` | dashboard, products, audit, reports, schedules, settings, staff |
| Till | `/pos/*` | the register, attendance, pre-orders |
| Customer | `/shop/*` | catalogue, orders |
| Public | — | `/login`, `/setup` (first run), `/display` (customer screen) |

---

## Commands

| Command | What it does | Needs |
| --- | --- | --- |
| `npm run setup` | Writes `.env`, creates the role and both databases, migrates. Idempotent. | Postgres superuser prompt |
| `npm run dev` | `src/server.ts` in dev mode: Next + Socket.io on one port. | — |
| `npm run build` / `npm run start` | Production build, then the same custom server. | — |
| `npm run verify` | `typecheck` → `ui:audit` → palette-up-to-date → `test`. **This is the gate.** | — |
| `npm test` | Vitest: unit + integration against real Postgres. | `TEST_DATABASE_URL` |
| `npm run ui:audit` | Fails if the retired theme reappears in `src/`. | — |
| `npm run route:audit` | Builds, serves, and checks that every one of the 17 screens renders a page whose CSS defines every class on it. | Postgres |
| `npm run brand:palette` | Regenerates the colour ramp. `-- --check` fails if stale. | — |
| `npm run brand:icons` | Rasterises the mark into the app icons. `-- --preview` prints them as text. | — |
| `npm run db:generate` | Regenerates the Prisma client after a schema change — **and commit it**. | — |
| `npm run db:seed:demo` | Seeds demo data. Refuses unless the shop is unconfigured. | Throwaway DB |
| `npm run smoke` | End-to-end checks over real HTTP. | A running server |
| `npm run acceptance` | The whole renter journey from an empty schema, including a refund and a bank notification; serves the production build itself. | Postgres |
| `npm run bank:bridge` | Reads the shop's own bank notification mailbox and posts what it finds to the app. `-- --file <eml>` parses a saved one and prints what it would post. | An IMAP mailbox, or none with `--file` |

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
- **Receipt numbers are gapless and un-reusable**, serialised on the shop row.
  Credit notes have their own gapless series (`shops.credit_note_running_number`),
  allocated in the same transaction, so a refund that is refused burns no number
  and a credit note never consumes a receipt number.
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
  unreachable store lets the caller through (ADR 0012 decision 5). The policy is
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
`brand:palette --check` + `test`. If you changed the schema, regenerate and
commit `src/generated/prisma/` (it is tracked; the `/generated/prisma` line in
`.gitignore` is a different path). If you changed an anchor colour, run
`npm run brand:palette` and commit `src/design/tokens.css`.

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
`acceptance` + `route:audit --skip-build` in a second, each with a PostgreSQL 17
service. Node is pinned by `.nvmrc` and `engines.node`, so the version the suite
runs on is the version a renter is told to install.

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
   `npm run route:audit`: it fetches each of the seventeen routes from the built
   server, collects the stylesheets each one links, and asserts that every class
   in the HTML is defined in that CSS. Do not re-write that check by hand — the
   first hand-written version is what caught the vendored theme's Google Fonts
   `@import`, which the "fonts are self-hosted" fix had not actually removed.
3. **A production session cookie is `Secure`**, so a plain-HTTP login cannot be
   stored by the browser. Mint a token with `createSessionToken()` from
   `src/lib/session-token.ts` and set it as `pos_session`, or pass it as a
   `Cookie:` header to `curl`.
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
both halves SSH again.

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
the shop runs (ADR 0007). All seventeen routes are on `src/components/ds/`,
the vendored Hope UI theme is deleted, `ui:audit` keeps it that way, `route:audit`
walks all seventeen screens, and `acceptance` drives the renter journey **including a
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

1. **A reconciliation over a range.** The dashboard reconciles today — confirmed
   transfers against the bills they closed, plus what is waiting — but a statement
   covering a week is still compared by hand.
2. **Customer messages on LINE.** Delivery works (ADR 0007); the *address* does
   not. A LINE push needs a LINE user id, this system stores only phone numbers,
   and asking members for one is a consent decision before it is a schema change.
   Until then `line` means the shop's own group, and customers get SMS or a
   webhook.
3. **A `/design` reference route** that renders every primitive with its tokens,
   so the library is visible in one place rather than inferred from call sites.

Known product gaps are listed at the end of `README.md` (overtime approval, LINE
addresses for customers, multiple branches, product images, RTL, object storage).
