# POS Realtime · ระบบขายหน้าร้าน สต็อก และพรีออเดอร์ 4 ขั้นตอน

An implementation of `system_requirements_document.md`: a realtime Point-of-Sale
with atomic inventory reservation, a four-phase pre-order lifecycle, RBAC, staff
cash-drawer reconciliation, and loyalty points.

The interface is built on **เหลี่ยมนอก**, this project's own design system: CSS
custom properties for the palette, the density and dark mode, and CSS Modules for
the components — no UI framework, and no CSS framework. Bootstrap's Reboot, the
Hope UI theme the first milestone was built on, and the bridge that re-skinned it
were all removed once the last screen moved across (ADR 0003).

---

## Stack

| Concern | Choice |
| --- | --- |
| Application | Next.js 16 App Router, TypeScript, one process |
| Database | PostgreSQL 17 |
| Data access | Prisma 7 with the `@prisma/adapter-pg` driver adapter |
| Node | 24 (`.nvmrc`; `engines.node` requires `>=22`) |
| Realtime | Socket.io mounted on the same HTTP server as Next |
| UI | In-house design system (`src/design/` + `src/components/ds/`): CSS custom properties + CSS Modules |
| Auth | bcrypt hashes + `jose`-signed JWT in an httpOnly cookie |
| Tests | Vitest against real PostgreSQL; Playwright Chromium for actual IndexedDB and the offline cashier journey |

### Why one process

`next dev` cannot host a second listener, so `src/server.ts` starts Next
programmatically and attaches Socket.io to the same `http.Server`. One origin
means the browser sends the session cookie to both the pages and the websocket,
and there is no proxy to configure. The websocket then needs no separate
authentication scheme.

---

## What is *not* vendored

There is no theme. The screens are drawn by `src/design/` and
`src/components/ds/`, so the Hope UI tree that the first milestone copied into
`public/hope-ui/` was deleted in phase 5 of the migration, together with the
`--bs-*` bridge in `tokens.css`, the `globals.css` that patched up what the bridge
could not reach, and Bootstrap's JavaScript. Three consequences, each a
choice rather than an accident:

- **Bootstrap is not a dependency, and never was one to install.** The vendored
  stylesheet bundled its own compiled copy; nothing pulls it in now.
  `npm run ui:audit` fails if a Bootstrap class name, a `data-bs-*` attribute or a
  `/hope-ui/` reference reappears in `src/`, because the failure it guards is
  silent: the markup still compiles and the screen merely renders unstyled. That
  is not hypothetical — it happened once during the migration.
- **No icon or chart package either.** `src/components/ds/icons.ts` is a
  hand-written 24×24 stroke set, and `src/components/ds/Chart.tsx` draws the one
  chart the dashboard needs, which is why `apexcharts` is not installed.
- **Some behaviour had to be written rather than configured.** The vendored
  `hope-ui.js` was jQuery-based and initialised on `DOMContentLoaded`, which Next
  cannot promise for a client-rendered page, so the user menu became
  `src/components/ds/Menu.tsx` — with `aria-haspopup`/`aria-expanded`, arrow-key
  movement, Home/End and Escape-to-close, none of which the original had. Dark
  mode is a `dark` class on `<body>`, resolved on the server from a cookie so
  there is no white flash, and it is the design tokens that key off it.

---

## The design system: เหลี่ยมนอก

The product is **เหลี่ยมนอก** (Liam Nong — "the square outside", the corner that
came off the box). The name belongs to the **platform chrome**: sign-in, the
setup wizard, the sidebar, the error pages. It never appears on a receipt, a
reprint or a customer-facing page — those carry the *renter's* brand, which is
what `shops` exists for (ADR 0002).

The **mark** no longer draws what the name means. It is the artwork the shop
supplied — one committed PNG, `public/brand-mark.png`, drawn as it is on the
platform chrome and resampled into every app icon — so restyling it is replacing
that file and running `npm run brand:icons`, not a change to a component. The name
is copy and the mark is a picture, so the two are allowed to say different things.
ADR 0015 has the measurements, the trace that was tried and lost the letter in it,
and what carrying a raster costs.

```
src/brand/          brand.ts (names, copy, the mark file) · BrandMark · Wordmark
src/design/         tokens.css · base.css · brand-page.module.css
src/components/ds/  the component library screens are migrating onto
```

Three decisions are worth knowing before changing anything here:

- **Colour is generated, not typed.** `src/brand/brand.ts` holds one seed; the
  50–900 ramp and the neutral ramp are derived from it into a marked block of
  `src/design/tokens.css`. Change the seed, run `npm run brand:palette`, and the
  whole product re-brands, because no screen hardcodes a colour.
- **The icons are ours.** `src/components/ds/icons.ts` is a hand-written 24×24
  stroke set. The previous arrangement used text glyphs (`☰`, `☾`) and emoji,
  which render differently on Windows, iOS and Android.
- **The fonts are self-hosted.** `next/font` downloads Inter (Latin) and Mitr (Thai) at
  build time and serves them from this origin. The old build `@import`ed Google
  Fonts on every page load, so a shop with flaky internet got fallback glyphs for
  Thai text — a till that mis-renders its own language is not a cosmetic problem.

| Command | What it does |
| --- | --- |
| `npm run brand:palette` | Regenerates the ramp from the seed. `-- --check` fails if stale. |
| `npm run brand:icons` | Resamples `public/brand-mark.png` into the PNG/ICO app icons. `-- --preview` prints them as text. |
| `npm run ui:audit` | Fails if the retired theme reappears in `src/` — a Bootstrap class, a `data-bs-*` attribute, a `/hope-ui/` reference. |
| `npm run doc:audit` | Fails if `package.json` defines a script no document runs, or a document runs a command that no longer exists. |
| `npm run route:audit` | Builds, serves, and opens every screen it knows about (26 distinct paths, 30 walks): each must render, land where it should, and have every class on it defined by the CSS that page loads, with no script, stylesheet or font fetched from another origin — a product photo may be a link to the shop's own file host (ADR 0014). |
| `npm run browser:target` | Reads the build the other gates made and fails if any file in it needs syntax newer than the phone a customer holds (ADR 0031). A class static block is a `SyntaxError` on a phone that stopped at iOS 15, and everything that needs JavaScript on that page is dead after it — a green `build` and a styled page say nothing about it. Makes no build of its own. |
| `npm run server:check` | Probes a **running** server and fails if it is not serving this checkout's build — a process left over from before a rebuild keeps serving HTML whose asset files no longer exist, which on screen reads exactly like a code bug. Read-only; `-- --url <base>`, `-- --verbose`. |
| `npm run limiter:race` | Starts two servers against one database and races the same cashier's session at one rate-limited door, to prove two processes share one limit rather than each getting their own. |
| `npm run backup` | One compressed `pg_dump` of the shop's database, plus a prune of whatever is older than `--keep` days. Refuses an empty dump and a database whose name looks like a test one. `-- --list`, `-- --dir`, `-- --keep`, `-- --force`. | — |
| `npm run bank:bridge` | Reads the shop's own bank notifications and closes the bills they pay. `-- --file <eml>` shows what it would post, without a mailbox. |
| `npm run line:wizard` | Walks the human half of the LINE feature (ADR 0030): the two channels to create in LINE's console, the values to paste, the callback/webhook URLs to register. `-- --verify` reports which doors the current `.env` opens. |
| `npm run verify` | `typecheck` + `ui:audit` + `doc:audit` + palette-up-to-date + `test`. The inner loop. |
| `npm run verify:all` | Every gate in dependency order — `verify`, then `acceptance`, `route:audit`, `browser:target`, `limiter:race`, `offline:browser` against the one build the journey makes. Stops at first failure; matches CI. |
| `npm run offline:browser` | Real Chromium/IndexedDB offline cash, replay/reconnect, loan release and recovery on a test-only scratch schema. Install Chromium with `npx playwright install chromium`; `-- --skip-build` reuses the production build. |

The migration is **finished**: every route is on the design system
and the vendored theme is gone — no Bootstrap classes, no Bootstrap JavaScript, no
`--bs-*` variables, nothing left to restyle. `npm run ui:audit` asserts that rather
than assuming it, which is what makes the removal an event instead of a hope.

`npm run route:audit` asserts the other half of the same claim, the half a source
scan cannot see: that each route's rendered markup is actually *styled* by the CSS
it loads. A stylesheet that stops being imported, or one that begins pulling a font
from a CDN, compiles and type-checks perfectly and ships an unstyled screen — which
is not hypothetical here, because exactly that survived the theme removal until
this check was written. All of it runs in CI on every push.

---

## Getting started

### 1. Install

Needs a running PostgreSQL 17 server. On Windows:

```bash
winget install --id PostgreSQL.PostgreSQL.17 --exact
```

Then, from the project root, one command does the rest:

```bash
npm install
npm run setup
```

`npm run setup` writes `.env` with a generated database password and session
secret, creates the role `pos_app` and both databases, and applies every
migration. It asks for your PostgreSQL **superuser** password, uses it, and never
stores it. It is idempotent, so running it twice is safe.

**It installs no demo data, on purpose.** A shop that is about to trade must not
start with 30 fake products, so the demo seed is opt-in *and* refuses to run once
a shop exists — `npm run db:seed:demo` is the explicit override, for a throwaway
database only.

The equivalent by hand is to create the role and both databases as the superuser,
`cp .env.example .env`, and then `npm run db:setup`.

`DATABASE_URL`, `TEST_DATABASE_URL`, and `AUTH_SECRET` are the three settings that
matter. Tests **refuse to run** unless the test database name contains `test`,
because they empty tables between tests.

### 2. First run — the setup wizard

```bash
npm run dev             # http://localhost:3000
```

No shop exists yet, so every path leads to **`/setup`**: shop name, branch, VAT
registration and rate, tax id, receipt prefix, and the first administrator. It
closes permanently afterwards — a second attempt is refused with a 409, and the
singleton primary key on `shops` is what makes that true even when two requests
race. The whole journey, from an empty schema to a printed VAT receipt, is
asserted by `npm run acceptance` below.

The operator's runbook — checklist before opening the till, the import template,
backups, password recovery — is `docs/renter-onboarding.md`.

### 3. Or use the demo data instead

On a **throwaway** database only:

```bash
npm run db:seed:demo
```

| Role | Phone |
| --- | --- |
| Admin (ผู้จัดการ) | `0800000001` |
| Employee — cashier | `0800000002` |
| Employee — stock | `0800000003` |
| Member | `0900000001` |

The password for all of them is `password123`. The roster, categories and 30
products the seed creates are what `npm run smoke` drives.

---

## Verifying it works

```bash
npm run verify:all     # every gate, in order, one command — this is the release check

npm run typecheck       # tsc --noEmit
npm run ui:audit        # the retired theme stays retired
npm run doc:audit       # the documents still name the commands that exist
npm test                # 1358 tests across 107 files: unit + integration
npm run smoke           # 42 end-to-end checks over real HTTP (needs npm run dev)
npm run acceptance      # 204 checks of the whole renter journey, from an empty schema
npm run route:audit     # every screen (26 paths, 30 walks) renders, and renders styled
npm run browser:target  # that build still parses on the phone a customer holds
npm run limiter:race    # two servers against one database share one limit
npm run offline:browser # real Chromium/IndexedDB and offline cashier/replay journey
npm run bank:bridge     # the shop's own bank notifications, in and out of the till
npm run notify:worker   # sends the queued messages, once (cron) or with --watch
npm run otp:gateway     # prints an OTP instead of texting it (local dev)
```

`npm run verify:all` is those gates in dependency order and nothing new: types and
tests first, because nothing is built for them; then the journey, which builds once;
then the gates that read that one artefact — the audit and the phone-compatibility
check — and the race and Chromium offline journey, because
a release check should be checking one build rather than several. It stops at the first failure, and it
is what the two CI jobs run between them.

`npm run doc:audit` is the smallest gate and the one with the longest reach: it holds
every script in `package.json` against the documents that are meant to mention it, in
both directions — a script nobody wrote down, and a document still running a command
that was renamed away. That second one is the reason it exists: a runbook naming a
command that no longer exists fails at the counter rather than in CI, and this is the
cheapest place to move the failure to.

`npm run acceptance` is the one that proves an *installation* works, which the
smoke test structurally cannot: its personas are seeded accounts, so it
presupposes the demo data. Acceptance drops a private PostgreSQL schema
(`accept`), migrates it empty, serves the production build against it, and drives
the setup wizard's API, the staff API, a catalogue spreadsheet and a VAT sale —
asserting that `net + VAT === gross` to the satang, that the first receipt takes
the renter's own series (`FR-<year>-000001`), that a reprint matches the sale
exactly, that a customer returning one item of two can come back for the rest, that a
consignment runs end to end (consign, sell, refund, pay out, with the consignor's own
portal agreeing at every step), and that the demo seed now *refuses* to touch the
configured shop.

`npm run route:audit` covers the other blind spot. Acceptance never reads a byte
of HTML, so a screen whose module was renamed, whose stylesheet was never imported,
or that quietly began fetching a font from another origin passes every one of its
checks. So this one builds, serves, sets up a shop the way a renter would, opens
every screen with the session that screen needs, and compares the markup against
the CSS that came back with it.

It is a Node script rather than curl and bash, and that is worth recording: on
Windows, Thai text in a `curl -d` argument is re-encoded through the console
codepage (the shop name arrived as `??????????`), and a mingw `curl -F
file=@/tmp/x.csv` cannot open a Git Bash path at all. Both produced empty
responses that looked exactly like server bugs, and the previous acceptance run
was misread because of it — the application was right and the harness was lying.

`npm test` covers, among other things:

- **No overselling.** 50 concurrent reservations against 20 units of stock:
  exactly 20 succeed, 30 are rejected with a 409, and `reserved_qty` lands on
  exactly 20. Repeated for multi-unit requests and for a cart that lists the same
  product twice.
- **The full lifecycle**, phase by phase, asserting the two stock counters and
  the point ledger at each step.
- **The Phase 1 timeout**, including that a confirmed order is never expired.
- **Cash settlement**, including that PromptPay is excluded from the drawer
  reconcile.
- **Attendance**, including that `work_hours` is computed by PostgreSQL, that the
  roster is joined to the day the shift actually started, and that a second open
  log is impossible even when the application guard is bypassed.
- **Reversing a paid sale**, including that money cannot leave the till with no
  credit note behind it, that clawing back points never blocks a customer's refund,
  and that the dashboard's cash figure nets what was handed back.
- **A partial refund**, including that a three-way split of a discounted ฿99.99 bill
  foots to the invoice exactly, that a line cannot be returned twice, that every unit
  comes back to the shelf exactly once, and that the bill is `refunded` only when the
  last line does.
- **The limiter on the doors that need no session**, including that a bucket refills
  continuously rather than resetting a window, that nobody is ever told to wait zero
  seconds, that a dual-stack loopback is one caller rather than two, that a forged
  `X-Forwarded-For` from a public address cannot mint a fresh bucket, that a burst of
  refused attempts writes exactly one row to the trail, that the spent attempt is in
  the shared table rather than in the process that spent it, and that a restart still
  refuses.
- **Customer accounts**, including that the same phone number written with dashes is
  the same customer, that a number a cashier already holds is refused rather than
  stolen from them, that this screen cannot edit a staff account, and that creating
  one and changing how it signs in are what reaches the trail — a rename is not.
- **Money arriving from a bank notification**, including the refusals: an amount
  matching a bill but naming none, two candidates for one amount, money that
  arrives after the QR was withdrawn, and a bridge retrying the same message.
- **The day's transfers against the bills they closed**, including that a satang
  is a difference, that a payment waiting longer than its own QR was valid is
  named, and that a QR transfer stops being flagged the moment its bill is rung up.

`npm run smoke` drives the running server as a browser would — logging in as all
three roles, placing a pre-order, confirming it, collecting it with a PIN,
reconciling the drawer, downloading all four SRS §8 workbooks (asserting the
xlsx content type, the ZIP magic bytes, and that a cashier is refused), and then
clocking the cashier in and out against the roster.

### Prepared cash when the network goes away

On `/pos`, open a drawer while connected, choose **เตรียมเครื่องขายออฟไลน์**, name
it and accept the warning: it holds invoice numbers (VAT shops) and call numbers
for today/tomorrow; other allocators cannot use those series until release. The
preparation reads the full active catalogue in pages, not only the first sixty.
Use HTTPS or localhost and a Chromium browser with IndexedDB and Web Locks.

Prepared mode takes **cash without members**, even online, using one durable
client identity before any replay. Changed online prices require reconfirmation;
pending queues keep their cached promise. The local ticket shows preparing/ready/
collected, the banner shows unsent cash and the last result, and reconnect/manual
send replays the ordered prefix without duplicating payment or stock. **ส่งบิลและ
คืนชุดเลข** restores ordinary tenders; closing the drawer performs that first and
refuses while bills/loans remain. Never clear browser data, switch cashier, close
or refresh the page while disconnected with pending bills. There is no cold offline
launch. Admin dashboard recovery is for a device that cannot return, based on
actual printed documents, not a guess at the server's last mark; missing money
records still need reconciliation. Physical printers and shop field use remain
unproven. See [operator instructions](docs/renter-onboarding.md).

### Telling people things (SRS §3, §4.2)

Alerts used to be in-app only: whoever was not looking at the screen heard nothing.
Two things now leave the building, and both are written **in the same transaction**
as the order they are about (`notifications`, ADR 0007):

| Moment | Who is told | What it says |
| --- | --- | --- |
| A pre-order is placed | The shop's own destination | The order number, the customer, the size and the money |
| An order is packed | The customer's phone | The order number, their pickup PIN, and when the hold ends (Bangkok time) |

Delivery is off until a channel is configured, and **off means nothing is queued at
all** — a shop with no gateway gets no rows to clean up, and the in-app path it has
always had keeps working. `NOTIFY_CHANNEL=line` addresses a LINE user id or group
id; `NOTIFY_CHANNEL=webhook` POSTs `{ to, text, kind }` to the shop's own gateway.

A customer's collection code is never pushed to the **shop's own group**, and that
is a decision rather than an oversight: a room full of staff phones must not hold
the codes that release parcels (`src/lib/notify-message.ts`,
`tests/notify-message.test.ts`). What a customer can get on LINE instead is their own
address (ADR 0030, below) — the code rides the customer's own LINE or nothing.

### The LINE door (ADR 0030)

A customer can **sign in with LINE**, bind their LINE account to this one from
their account page, and — with one more tap — be told "สินค้าพร้อมรับ" on their own
LINE instead of only in the app. The phone stays the identity: LINE is a *door*,
the same way Google is (ADR 0020), and binding a LINE account to a row that may
already hold points and history proves the phone by **OTP**, because a callback in a
stranger's browser plus a typed number is exactly the takeover ADR 0020 §4 refuses.
Binding from an already-signed-in account page needs no OTP — the session is the proof.

Consent is two facts, and a push needs both: the customer's (`line_consent_at`, with
the version of the text they read; withdrawal clears the binding and the consent
together) and the shop's — a push only reaches a **friend** of the Official Account,
so the webhook (`POST /api/v1/line/webhook`, HMAC-verified over the raw body) records
follows and unfollows. Planning a message for an unfollowed user would burn the retry
schedule against a door LINE refuses with a 200.

The shop's own group gains two facts about its own money, written in the same
transaction as the act: **a bill was refunded**, and **a bank notification was
dismissed by hand** — the two things an owner otherwise learns late.

Provisioning is two LINE channels and five values; `npm run line:wizard` walks the
human half and `-- --verify` reports which doors are open.

Sending is `npm run notify:worker` — once for cron, or `--watch`. It claims each
message by moving its next attempt forward *before* sending, so two workers cannot
double-send and a worker killed mid-send leaves a row that comes back. Failures are
retried on a fixed schedule (1, 5, 15, 60, 360 minutes) and then **abandoned** with
the gateway's own words attached, which is what the dashboard's undelivered card
shows — a shop whose URL is wrong finds out from the screen rather than from a
customer who was never told.

### Enrolling a customer (SRS §5)

A member is not an address-book entry — it is a **credential that can reserve stock
without paying for it**, which is the one capability here worth inventing an identity
to get — so the screen that hands one out says so: creating a customer is audited,
and so is every later change to how that account signs in. Renaming one is not,
because the value of a trail is in being narrow. `docs/adr/0010-member-accounts.md`
is the decision; `docs/adr/0011-counter-enrolment.md` is the counter's half of it.

Somebody types a name, a phone number and a **temporary** password and reads it to
the customer, which is the only flow that works in a shop with no email address on
file and no app on the customer's phone. There are two doors to that form, and the
difference between them is who is standing where: a manager at `/admin/members`,
which also lists customers and can edit or close an account, and **the till**, where
`/pos` → *สมัครสมาชิกใหม่* opens the same enrolment as a dialog over the bill. The
basket survives it, and the customer is attached to the bill it closes — a cashier
enrols somebody and keeps selling. Editing stays behind the admin gate: adding a
customer is a counter act, changing how one signs in is not.

Uniqueness runs across every role and survives punctuation (`080-000-0002` and
`0800000002` are one number), because a cashier whose number was reused by a customer
would silently stop being able to sign in — and the refusal says so in Thai, which is
the one failure this flow actually meets at a counter. Points are displayed and never
edited: a balance is the sum of a ledger, and a text field that could write one is a
text field that can invent a liability.

The list is loaded whole and filtered in the browser, with the customer's points and
order count alongside the date they joined. Closing an account stops them signing in
and leaves their orders, points and uncollected parcels exactly where they are —
staff can still find them by the phone number they already know.

### The customer's own door (`/login`)

The front door belongs to the customer (ADR 0029): `/login` — the address the domain root,
the proxy, `signOut` and every printed QR already point at — renders the customer's two
doors side by side:

- **Continue with Google**, for a customer who found the shop online (ADR 0020). The
  Google credential is verified in-process against Google's JWKS; on a first visit the
  customer gives a phone number, and the name comes from their Google profile. A number
  that already has a customer is **refused, not linked** — a typed number proves nothing,
  and attaching it would be a takeover — so the counter's password is the way into that row.
- **Phone and password**, for a customer the shop enrolled at the counter.

The staff form folds behind one quiet button below the card (one tap, `aria-expanded`), and
the demo accounts travel inside that fold. The old customer address `/shop` redirects here,
so QR codes printed before the move keep working.

Both rest on one value. Leave `GOOGLE_CLIENT_ID` unset and the Google door is still
present, but says plainly that the shop has not configured it rather than showing a
button that cannot work. To try it on your own machine: create an OAuth 2.0 **Web
client** in Google Cloud Console with authorized JavaScript origin
`http://localhost:3000` and set `GOOGLE_CLIENT_ID` in `.env`; a Google sign-in then takes
a phone number and nothing else. (A **phone change** still proves the new number by OTP;
`npm run otp:gateway` prints that code instead of texting it — see the command list above.)

### Collecting a pre-order (SRS §3)

The customer's order screen shows two credentials the moment staff pack the bag: a
**QR** and the four-digit **PIN** underneath it. They fail differently — the QR is
faster and cannot be mistyped, the PIN survives a flat battery and can be read
down a phone — so both are offered rather than one being chosen for the customer.

The QR is a signed token (`src/lib/pickup-token.ts`), not a stored secret. It names
exactly one order, it expires when the hold does, and its own audience means a
signed-in member's session cannot be presented as a pickup code (asserted in
`tests/pickup-token.test.ts`). Nothing is written to the database to make the code
work, so a shop that rotates its signing secret invalidates codes on the shelf —
reprint them rather than leaving a customer holding a dead one.

The till has one box at the counter, and the *shape* of what arrives decides where
it goes: three dot-separated segments is a scanned code, four digits is a PIN,
anything else is a phone number (`src/lib/pickup-scan.ts`, pure and unit-tested —
it used to be a ternary inside a screen, where the only way to test it was to
render the screen). All three roads end at the same `ready_for_pickup` filter, so a
code for a parcel that has already been collected finds nothing, exactly as its PIN
would.

A bad or expired code is a **422** with a readable message, not a 500 — a stale QR
is not something "going wrong on our side". The board the queue looks at carries
neither the PIN nor the code, and that is pinned by a test over the serialised
payload rather than field by field (ADR 0006 §6).

Whichever credential was used, the dialog that opens lists each line with the
product's photo when the shop has given it one (ADR 0014). That is the moment the
counter has to answer "which of these bags on the shelf is this order's", and it is
the one question an order number cannot answer at all and a photo answers at a
glance — so both projection routes that serve that dialog, the lookup by credential
and the read by id, carry the same two fields per line.

### Reports and exports (SRS §8)

`GET /api/v1/reports/export?type={report_type}&from={date}&to={date}` returns one
`.xlsx` attachment per call. `type` is one of `sales_summary`,
`product_performance`, `employee_attendance`, `stock_audit`; `from`/`to` are
`YYYY-MM-DD` calendar days interpreted in Asia/Bangkok and default to the
trailing 30 days. The endpoint is **admin-only** and, being the single binary
response in the app, bypasses the JSON envelope on success while still returning
the usual `{ error }` shape on failure.

Each workbook has one sheet whose row-1 headers are the SRS §8 column names
verbatim. Money is written as numbers (so a column sums in Excel) and timestamps
as Bangkok strings formatted without `Intl`, so an export is byte-stable across
hosts. The admin screen at `/admin/reports` picks the type and date range and
shows the exact columns before downloading.

`employee_attendance` reads `time_logs.work_hours` through a raw query, because
that column is a stored generated column Prisma cannot model. It is populated by
the scheduling and attendance feature below.

### Staff scheduling and attendance (SRS §6)

The manager rostered two employees in the seed, so the demo timesheet is not
empty; rosters upsert on `(employee, day)`.

- **`/admin/schedules`** — write a shift (employee, day, `HH:MM`–`HH:MM`), browse
  the roster, and read the timesheet for any date range. Two admin-only actions
  live here: back-filling a shift nobody clocked, and removing a row entered in
  error.
- **`/pos/attendance`** — the staff time clock: one button, plus the day's roster,
  hours so far, and every log for the day.

| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /api/v1/attendance/current` | staff | own day: open log, roster, hours |
| `POST /api/v1/attendance/check-in` | staff | clock on |
| `POST /api/v1/attendance/check-out` | staff | clock off (returns `work_hours`) |
| `GET /api/v1/attendance` | admin | timesheet for a date range |
| `POST /api/v1/attendance/manual` | admin | back-fill or correct a row |
| `DELETE /api/v1/attendance/{id}` | admin | remove a mistaken row |
| `GET` / `POST /api/v1/schedules` | admin | read the roster; upsert one shift |
| `DELETE /api/v1/schedules/{id}` | admin | un-roster a shift |

Wall-clock times are stored as `date`/`time` columns rather than instants — a
shift is a statement about the clock on the wall, so "09:00" must not mean
different hours in different timezones. Lateness and overtime are then pure
functions of the actual check-in against the rostered window, shared verbatim
with the §8 export so the screen and the workbook can never disagree.

An employee can never clock in for someone else: the route always uses the
caller's own id, and back-filling somebody else's shift is a separate admin-only
endpoint that says so.

---

## How the SRS maps onto the code

| SRS | Where |
| --- | --- |
| §7 schema | `prisma/schema.prisma` + `prisma/migrations/.../migration.sql` |
| §4.1–4.2 atomic stock | `src/lib/inventory.ts` — one conditional `UPDATE` per mutation |
| §4.3 adjustment audit | `adjustStock()` + `stock_logs` |
| §3 four phases | `src/lib/orders.ts`, pure machine in `src/lib/order-state.ts` |
| §5 loyalty | `src/lib/loyalty.ts` (pure) + `src/lib/points.ts` (ledger) |
| §6 scheduling & attendance | `src/lib/attendance.ts` (persistence), `bangkok-time.ts` + `attendance-rules.ts` (pure) |
| §6.2 cash drawer | `src/lib/shifts.ts` (pure) + `src/lib/cash-shifts.ts` (persistence) |
| §8 Excel exports | `src/lib/reports.ts` (queries) + `src/lib/report-spec.ts` (columns/formatting) + `src/lib/excel.ts` (rendering) |
| §2 RBAC | `src/lib/roles.ts`, enforced in `src/proxy.ts` **and** every route handler |
| Reversal of a paid sale (beyond the SRS) | `src/lib/credit-notes.ts` (the transaction) + `src/lib/refund-plan.ts` (the arithmetic) + `src/lib/order-state.ts` (the `refund` edge) — ADRs 0004, 0008 |
| §3 pickup QR | `src/lib/pickup-token.ts` (the signed code), `pickup-scan.ts` (what the counter typed), rendered on the customer's order — ADR 0006 |
| The drink queue (beyond the SRS) | `src/lib/queue-number.ts` (what a number looks like, pure) + `src/lib/fulfilment-state.ts` (the machine, pure) + `src/lib/fulfilment.ts` (the board and the taps), printed on the receipt, tapped at `/pos/queue`, called on `/display` — and switched off entirely by a shop that does not call its customers — ADRs 0017, 0018, 0027 |
| Whether this shop takes pre-orders (beyond the SRS) | `placePreOrder` refuses where the order is placed, before the number is spent and before any stock is reserved; `shopColumns` writes the switch only when a save was sent the key — ADR 0028 |

The domain rules are split into **pure functions** (loyalty, settlement, the state
machine, the discrepancy formula, what the counter just scanned) and
**persistence** modules. That split is why the money rules can be checked without
a running server, and why a refusal is a typed value the tests can assert on
rather than a message somebody has to read.

---

## Shop identity, VAT, and the renter's own setup

The SRS has no shop identity and no tax concept at all — receipts, page titles
and the tax rate were hardcoded — so this is the largest *addition* to it. See
`docs/adr/0002-shop-identity-and-vat.md` for the reasoning and the tradeoffs.

| Surface | What it is for |
| --- | --- |
| `/setup` + `POST /api/v1/setup` | The wizard: shop, VAT and the first administrator, written in one transaction. Refuses with 409 once a shop exists. |
| `/admin/settings` | Shop name, branch, legal name, tax id, VAT registration and rate, the **shop logo link** (a link to where the shop keeps its pictures, not an upload — ADR 0014), receipt prefix and footer, the supervisor discount limit, the PromptPay account it receives on, the two switches (**เรียกลูกด้วยเลขคิว**, **เปิดรับพรีออเดอร์**) and the **next receipt number**. |
| `/admin/staff` | Staff accounts, created from the app rather than from SQL. The last administrator cannot be deactivated. |
| `POST /api/v1/members` + `/admin/members` | Enrolling a customer, with a temporary password they change themselves later, plus a searchable list, their points and deactivation. Reachable from the till (`/pos`) as a dialog over the bill and from the back office as a screen; editing an account stays admin-only. |
| `/admin/products` | The catalogue: create a product, or **edit** one — name, category, barcode, cost and sale price, description — without opening the spreadsheet again. Stock moves only through the signed adjustment, so every change of goods keeps a reason and a `stock_logs` row; the photo, the offline reserve and the consignment terms each keep the dialog they need, because they answer different questions. |
| `/admin/products` → categories | Categories are createable at last, and deleting one that still has products is refused by the database. |
| `/admin/products` → import | CSV or `.xlsx` catalogue import: a preview that writes nothing, a downloadable template, and its own `REASON_IMPORT` audit entries. |
| `GET /api/v1/orders/{id}/receipt` | Reprint data, read from the order's own snapshot columns, so a 2026 receipt still shows 7% in 2027. |
| `POST /api/v1/orders/{id}/refund` | Reverse a paid bill — named lines and quantities, or everything outstanding — and issue a credit note. Supervisor PIN required, always. |
| `GET /api/v1/orders/{id}/credit-note` | Reprint data for that credit note — the sibling of the receipt route. |
| `POST /api/v1/payments/inbound` | A bank notification, from the shop's own bridge. Machine-only, shared secret. |
| `GET /api/v1/payments/inbound` | Money the bank reported that could not be matched to a bill. Admin-only. |
| `/admin/dashboard` → เงินโอนเข้าวันนี้ | Confirmed vs closed transfers for the day, the awaiting-collection list, and the unmatched list. |

Two database-enforced invariants carry most of the weight:

- `CHECK (net_amount + vat_amount = final_amount)` — a tax receipt whose lines do
  not add up is refused by the database, not by a code review.
- `CHECK (id = 1)` on `shops` — the singleton is a fact, so a racing second setup
  cannot win one.

Money is `DECIMAL(10,2)`; tax arithmetic is done in integer satang
(`src/lib/vat.ts`), because a breakdown off by one satang is a document that does
not balance rather than a rounding nit.

**This is not a compliance certification.** The receipt layout follows the usual
Thai retail format, but whether it satisfies the Revenue Department is the shop's
accountant's call. What the software *does* now provide is the paper trail that
question turns on: see below.

### Reversing a paid sale — credit notes

The SRS has no void, refund or credit-note concept anywhere, and a gapless receipt
series with no way to reverse one is a gap a tax-invoice-issuing shop cannot live
with. `docs/adr/0004-credit-notes-and-refunds.md` is the decision; this is what it
means in practice.

**A credit note itemises what it reverses.** `credit_note_items` records the lines
and quantities going back, so a customer returning one item out of three is served
at the counter and the invoice survives untouched for their next visit. There is no
free-form amount: an amount that matches no line is a document that proves nothing.
A bill takes several notes, numbered within it (`sequence`), and a line cannot be
returned twice within one note — the unique index catches two requests that raced
past the state machine.

**The closing note takes the remainder.** A partial refund has to split an
order-level discount across the lines coming back, and a two-decimal round of that
share leaves a satang somewhere. The note that empties the order is *defined* by
subtraction — the invoice, less what the earlier notes already gave back — so no
split of one sale can strand a satang, however many visits it takes. The same
trick keeps the tax exact: the closing note takes the net the earlier notes did not
round to, so the notes reconstruct the sale's own net and VAT to the satang.
`src/lib/refund-plan.ts` is that arithmetic, pure, because it ends up on a legal
document — and the till previews with the same function the server writes with.

**A partly credited invoice is still the invoice.** The order's own totals and its
receipt number are never rewritten; what was refunded is the sum of the notes,
which the database can answer rather than a column that can drift. A sale is
`refunded` only when the notes have taken back everything on it, because a bill that
has been partly credited is money the shop is still entitled to hold.

**The number comes from the shop's own series.** `shops.credit_note_prefix` and
`shops.credit_note_running_number` mirror the receipt columns, allocated in the
transaction that writes the note, so a credit-note series is as gapless as the
receipt series it reverses — and a refused refund burns no number. It is a
*separate* series: `CN-2026-000001` does not consume `FR-2026-000042`.

**Money only leaves in one of two ways**, and the credit note records which:

- **Out of an open drawer.** The refund writes a `payments` row with
  `direction = 'refund'` against the current shift, which *reduces* that drawer's
expected cash — the cashier counting at close finds the money already accounted
  for rather than a mystery shortage. With no drawer open the refund is refused
  with `NO_OPEN_SHIFT`, exactly as a cash sale would be.
- **By hand in the banking app.** The leg carries no `shift_id` at all, because
  it never touched a till. Writing it against a shift would invent a discrepancy
  for money that no cashier handled.

No refund is ever *sent* automatically: pushing money back out needs bank API
onboarding, which is the shop's decision and its paperwork, not a feature flag.

**Money is stored positive and signed by `direction`.** `payments` keeps
`CHECK (amount > 0)`, so a refund leg is not a negative row; it is a positive row
whose direction says which way the money went. Every aggregate then has to decide
what it means, and it cannot do so by accident — which is the point. Cash in the
drawer nets refunds; gross takings do not, because a bill paid on Monday and
refunded on Friday belongs in Monday's takings *and* in Friday's refunds.

**Stock comes back through the same primitives.** Every unit on the bill returns
to `stock_qty` (never to a reservation — a refunded sale's goods go on the shelf)
as a `pos_refund` stock movement, so the SRS §4.3 adjustment log explains it in
its own words. Points are reversed too, and **clamped**: a customer who has
already spent the points their purchase earned does not have their refund blocked
by a negative balance. The unclawable remainder is recorded on the note as
`points_forgiven` rather than silently dropped.

The whole reversal is audited as `refund_order`, naming the cashier who was at
the till and the supervisor whose PIN allowed it — the same shape as a staff
cancel. Rewriting the original receipt is never an option: its number is already
in somebody's hands, so the credit note is a second document that references it.

### Confirming a transfer automatically, for nothing

A customer pays by PromptPay and the bill should close itself. The honest position
is that this system cannot know money arrived — only a bank can — so the question
is who carries the fact from the bank to the till. The usual answer is a payment
provider or a bank API; both cost money per check or per month, and both ask the
shop to sign up for something before the first transfer can close a bill.
`docs/adr/0005-automatic-transfer-confirmation.md` is the decision; the short
version is that the shop's own bank notification does the carrying.

```bash
npm run bank:bridge -- --file ./notification.eml   # what would be posted
npm run bank:bridge -- --once                     # one pass over the mailbox
npm run bank:bridge -- --interval 60              # keep watching
```

The bridge reads a mailbox the bank already emails, extracts the amount with the
shop's own pattern, and posts the notification to `/api/v1/payments/inbound` with
the message's own id and the bank's own timestamp. Everything about *reading* mail
is pure and unit-tested (`src/lib/bank-mail.ts`); everything about *deciding* which
bill the money paid is pure and unit-tested too (`src/lib/inbound-match.ts`); what
is left in the script is a socket and a loop.

**The matcher never guesses.** It requires the amount to match a QR exactly — in
satang — and then requires the notification to name that QR's reference as a
whole token. An amount on its own is refused even when exactly one QR is open,
because two customers in one queue can owe the same ฿107.00 and "there was only
one" is a fact about the moment rather than about the transfer. Money that arrives
after the QR was withdrawn is refused; so is money for a bill that was already
closed, which is what a retrying bridge sends the second time.

**Nothing is dropped, and nothing is invented.** Every notification is recorded in
`inbound_payments` — matched or not, with the reason it could not be attributed,
and with `NULL` rather than a fabricated number when the amount could not be read
at all. An amount of zero or one satang in the place where a real amount belongs
is the one thing that table must never contain. Whatever is left unattributed
appears on the dashboard, and an admin can close it with a reason (audited as
`inbound_transfer_dismissed`) when it turns out not to be a sale of ours. The same
bank message is recorded once, enforced by `UNIQUE (source, external_id)` rather
than by the bridge's own bookkeeping.

**Refunds are never sent this way.** Money leaves through the open drawer or by
hand in the shop's banking app, and the credit note says which. Automating a payout
needs bank API onboarding and an authority this system should not hold: a bug in a
matcher that closes a bill is a bill closed wrongly, while a bug in one that pays
out is money gone.

**And the day adds up in one place.** Every transfer leaves two traces — the bank's
confirmation and the bill that closed — and the dashboard compares them: confirmed,
closed, and the difference with both of its normal explanations (a transfer
confirmed by hand at the till, or money that arrived and was never rung up).
Beneath it are the two lists that make it actionable: payments the bank confirmed
that no bill has closed (the expensive one — the customer has paid and no receipt
exists), and money that could not be matched to anything at all. Where the figures
disagree, the screen says which side is larger; nothing here claims to know why.

### Refusing to be guessed at

Every endpoint here refuses the wrong answer already — a wrong password signs nobody
in, a wrong supervisor PIN issues no token, a wrong webhook secret writes no row. What
none of them bounded was how *many times* it could be asked: a supervisor PIN locks
after five wrong tries for one admin, and nothing stopped an attacker walking the list
of admins five tries each. `docs/adr/0009-rate-limiting.md` is the decision.

The limiter covers the five doors that need no session — signing in, supervisor
approval, the setup wizard, display pairing, and the bank-notification webhook — plus
one signed-in write, enrolling a customer, and it is a **token bucket**, so a caller
with no history arrives full, a burst is spent and refilled at a rate rather than
locked out until a clock turns, and nothing has to be reset. Login counts two things, because they are two questions: wrong passwords for one
account (keyed by the address *and* the identifier, so guessing at one login cannot
lock out the colleague beside it) and wrong passwords from one address, which is what a
spray across many accounts spends.

**A signed-in till is not limited**, deliberately: a cashier who can outrun the API is a
performance problem, not a security one, and a ceiling a busy Saturday hits is one the
shop switches off. The single exception is enrolling a customer, because what that call
produces is not a sale but a credential that can reserve stock without paying for it —
ten in a row, then one a minute, with the budget belonging to the **account**, so two
tills on one wifi are two budgets and signing out does not refill yours. The failures are
charged and the successes are free, so a shop behind one address cannot exhaust itself
logging in at nine o'clock.

The policy is pure and unit-tested (`src/lib/rate-limit-policy.ts`); the buckets are rows
in the shop's own database, so **a restart forgets nothing and two processes enforce one
limit between them** rather than one each. Nothing about a bucket is in the process:
spending an attempt is an upsert that takes a row lock, and the clock is the database's,
because that is the only clock several processes agree on. `npm run limiter:race` proves
it the only way that counts: two servers, one database, the same cashier signed in at
both, and one burst spent between them rather than one each. Who a request is from is the
address the **socket** reports, with `X-Forwarded-For` believed only when that socket is
itself private, so a caller cannot pick its own bucket by sending a header. When a burst trips, the trail gets **one** row (`rate_limited`) naming the door,
the address and the account that was guessed at — one, not one per refusal, because this
is the one endpoint an unauthenticated caller could otherwise make write to the audit
table for free.

---

## Consigned goods (ฝากขาย)

A member leaves goods with the shop and the shop sells them as principal, owing an agreed
percentage of the net (excluding VAT) — decided in `docs/adr/0023-consigned-goods-and-the-consignors-share.md`
and built across nine tickets under `.scratch/consignment/`.

**One product is either shop-owned or consigned, never both.** A consignor and a share sit on
`products` together (the database refuses the two moving apart); a share of the net excluding
VAT is written to a `consignor_payables` ledger as one credit per consigned line, *inside the
sale's own transaction* at both completion sites (the walk-in bill and the pre-order handover),
so a sale that rolls back owes nobody. A refund claws the share back in the refund's own
transaction, proportional to the units returned, and a payout already taken just leaves a
negative balance the next payout nets.

**Consigned goods stay outside the shop's own figures.** The dashboard's stock valuation counts
only owned products; the consigned stock and the shares owed are reported separately, and the
shares-owed figure is the ledger's own sum. A consigned product also **cannot be sold offline**,
by decision: the device carries a flag and the till refuses the line with a Thai message that
names the next step (connect) — a pre-order, which completes online, is unaffected.

**Money leaves the shop the way it always does** — from the open drawer or by hand in the shop's
banking app (ADR 0004), never an automatic transfer. From `/admin/consignors` an admin settles a
consignor's balance (cash needs an open drawer and carries its shift; a transfer never touches
one), a payout cannot exceed what is owed, and the statement it produces lists the sales and
refunds it settles — the ledger debit points back at that statement, so the arithmetic and the
paper can never be separated. A cash payout is counted out of the drawer, so the close still
reconciles. The whole act is one transaction and one audit row (`consignment_paid`).

**The consignor sees their own position** in the customer portal's **ฝากขาย** tab: what the shop
owes, the goods they have left with the shop and how much of each has sold, and every movement —
a payout reading as a settled statement, a refund as a reversal. The view is scoped to the
signed-in member's session, so one phone number can never read another's balance.

### The counter at `/pos` (ADR 0026)

A week of real use turned up four defects that were one bug each, and they are all the
same mistake: a rule copied into a second place instead of asked for once.

**A staff cancellation is audited, not approved.** An employee cancelling a pre-order
used to be refused outright — the route demanded a supervisor's PIN and the PIN prompt
was never wired into the board, so the button could not do anything at all. `void_order`
gates the *till's* void because that reverses money that already changed hands; an
unconfirmed pre-order holds only a reservation, and releasing one is a shelf decision.
So `cancelOrder` now takes `staffVoid` and writes a `void_order` row naming the employee,
with no approver and `detail.approval = 'not_required'`. The trail still answers "who
released this". A member withdrawing their own pre-order is still not audited, and a
refund still needs a PIN.

**The countdown counts to the server's deadline.** `orders.confirm_deadline` is stamped
when the pre-order is placed, and both the board and the expiry sweeper read it. Before
this the board held its own `CONFIRM_TIMEOUT_MINUTES = 15` while the server swept on
`created_at + PREORDER_CONFIRM_TIMEOUT_MINUTES`, so changing the setting silently
re-dated the orders already in the queue. The default is now **30 minutes** — these
pre-orders arrive from a phone, not from a counter. A walk-in sale has no Phase 1, so the
column is null for most of the table.

**Pre-orders can be scanned and paid at the till.** `PreOrderHandover` is one dialog
with two callers: the board at `/pos/preorders`, and a collection strip on `/pos` where a
customer holding a QR, a PIN or a phone number is paid without being walked to another
screen. It offers cash, PromptPay and a split, because the money rules for a pre-order
are the walk-in sale's (`buildSettlement` is shared) — `completeOrderSchema` gained
`intentRef` and `completeOrder` consumes the intent exactly as `createPosSale` does.

**Transfers can be confirmed by hand, and a dead QR can be replaced.** A shop with no
bank notification bridge never receives the event that closes a PromptPay bill, and the
sheet used to *remove* "ยืนยันรับเงิน" while one was in flight — leaving a cashier who
had watched the money land with nothing to press. Two buttons, both reaching work the
server already had: **ยืนยันว่าโอนแล้ว** (a supervisor approval bound to the intent's
reference, audited as `manual_payment_confirm`) and **ออก QR ใหม่**, which issues a fresh
intent rather than re-drawing the same payload, so the countdown restarts and the old
reference is cancelled.

**The queue numbers are the call numbers.** `คิวเครื่องดื่ม` on `/pos/queue` is ADR 0018
beside ADR 0017: a three-digit number issued per walk-in sale, printed on the receipt so
the customer can be called, and a board of what is being made versus what is waiting to
be collected. A pre-order has no call number — its handover is the moment it is paid, and
it has its own identifiers. A shop that hands everything over in one bill turns the whole
thing off in `ตั้งค่าร้าน` (`เรียกลูกด้วยเลขคิว`): no number on the slip, no ticket, no page in
the till's navigation — see ADR 0027.

**A shop that prepares nothing can say so.** `เปิดรับพรีออเดอร์` in `ตั้งค่าร้าน` does for pre-orders what `เรียกลูกด้วยเลขคิว` does for the
queue, and is a second switch rather than the other half of the first: a shop can take
orders by phone and hand them over the moment the customer walks in — pre-orders on, call
numbers off. It is refused where the order is placed (`placePreOrder`, inside the
transaction, before the `PO-` number is spent and before stock is reserved), so a member
who already had the storefront open is told `ร้านนี้ยังไม่เปิดรับพรีออเดอร์` rather than
watching a basket do nothing; the storefront drops the basket, the steppers and the button
together, and the pre-order board stays reachable for orders already placed — see ADR 0028.

**The basket is one tap away on a phone.** `SplitPane` stacks into one column below its
breakpoint and the storefront stacks content first, which is right until you count the
scrolling: the basket is the only control that places a pre-order, and it sat after every
product in the shop, so thirty items put the checkout thirty screens away from the first
tile. A bar now follows the customer down the catalogue with the pieces they have picked
and what those cost, and tapping it lands on `รายการจอง` — below the stuck top bar rather
than under it, and on the region itself, so a keyboard user's next Tab continues *inside*
the basket instead of past it. It appears only when there is something to jump to, and
only below the breakpoint, because above it the basket is beside the grid already — and it
carries no `aria-live`, because the steppers already announce their own count and two
polite regions counting the same pieces would say every number twice.

Three things in it are decisions rather than details. It is an `<a>` rather than a
`<button>`, so the jump is the browser's own: it works before the page has hydrated, and
the destination is in the URL. It wears the quiet variant rather than the brand fill,
because at the end of the page it sits directly under the basket's own
`จองสินค้า (พรีออเดอร์)` — two full-weight buttons stacked, the lower one pointing at the
spot the customer is already looking at, is worse than a link. And its numbers come from
the same pure function the basket card reads (`src/lib/basket.ts`), which is also where an
id whose product has left the catalogue is dropped from the count as well as the total —
the shape this screen really does meet, because it re-reads its catalogue after a
reservation. Not built, and written down here so the next round does not re-propose them
blind: a sheet that slides the basket up over the catalogue (the basket would have to be
rendered twice or moved, plus an open state to get wrong) and a checkout page of its own
(a page whose only action is the button this bar is now one tap from). **`/pos` is not
covered**: the till's frame is `height: 100vh` with its panes scrolling internally, so the
same bar there is a different piece of work rather than the same one.

**Sales history is a screen.** `/admin/sales` lists every completed sale, searchable by
receipt number, customer name and Bangkok date range, and reprints a receipt from the
same projection the printed one uses. It exists because the three previous answers were
not answers: reports export spreadsheets, `/receipts?t=` only opens a link the customer
already holds, and the till and the board show no history.

### A member offers their own goods (ADR 0025)

A member who makes things at home should not have to stand at the counter while an owner types one
screen per item. So the **offer form is a panel in the member's own ฝากขาย tab** on
`/shop/account` — no Google Form, no Apps Script, no shop setting, and no new tab — and the
owner's inbox at the top of `/admin/consignors` decides what arrives. Decided in
`docs/adr/0025-a-member-offers-goods-on-their-own-account.md`.

**An offer is not an arrangement.** The form creates a *pending submission*: no product, no
percentage, nothing owed. Approving one is what creates the product, calls the same
`setConsignment` every other consignment goes through, and moves the shelf with a
`consignment_received` movement a stock report can tell from a delivery. The approval dialog
asks for the two things only a person can supply — the percentage, and how many units actually
arrived, because counting at home and counting at the counter disagree.

**The photographs and the paperwork follow the product.** They are stored as links (ADR 0014
extended from images to documents), and `product_id` is filled in at approval, so one row serves
the inbox and the record afterwards. A Drive *file* link is not an image URL, so each attachment is
also drawn as a link that opens it when it cannot be rendered.

**Nothing decides anything quietly.** The owner is the session, so `consignor_user_id` is NOT
NULL and there is no "phone that matched no account" case to guard. A double tap on a phone is one
offer, not two (`client_ref` is unique, looked up before the insert). And a refusal needs a
reason — which the member then reads on their own account, in the same tab they sent it from.

## Deliberate deviations and additions

See `docs/adr/0001-schema-deviations-from-srs.md` (the schema) and
`docs/adr/0002-shop-identity-and-vat.md` (shop, tax, receipts) for the reasoning.
In short:

- `gen_random_uuid()` instead of the `uuid-ossp` extension — same result, one
  fewer extension, built into PostgreSQL 13+.
- `stock_logs.reason` added. SRS §4.3 mandates an adjustment-reason enum
  (`REASON_RESTOCK` etc.) that §7's DDL never declares a column for.
- `orders.pickup_expires_at` added. SRS §3 Phase 3 mandates a holding-time
  limit with no column to store it.
- A `payments` row per payment leg rather than one `mixed` row, so that
  `SUM(amount) WHERE method = 'cash'` is exactly the physical cash in the drawer.
- A seeded, inactive `SYSTEM_USER_ID` account owns system-driven stock
  movements, because `stock_logs.changed_by` is `NOT NULL`. Weakening that
  constraint to accommodate automation would have cost the audit trail.
- The route guard lives in `src/proxy.ts` exporting `proxy()`, which is the
  Next 16 replacement for the deprecated `middleware.ts` convention.

## Licence

**Proprietary — all rights reserved.** See `LICENSE`. This is software a shop runs
and owns rather than open source: copying it, redistributing it and offering it as
a hosted service are all reserved to the copyright holder. Commercial licensing
goes through them.

## Documentation

| Document | What it is |
| --- | --- |
| `system_requirements_document.md` | The specification this implements. |
| `CONTEXT.md` | The vocabulary: the words a counter says, the words the code uses, and which is which. |
| `docs/renter-onboarding.md` | The operator's runbook: install, the wizard, the daily routine, backups, recovery. |
| `docs/homelab-deploy.md` | Running it on a box at home: the systemd units in `deploy/systemd/`, the TLS the secure cookie requires before a second device works, the backup timer, the restore drill, and upgrades. |
| `docs/adr/0001-schema-deviations-from-srs.md` | Every place the database departs from SRS §7, and why. |
| `docs/adr/0002-shop-identity-and-vat.md` | Shop identity, VAT and gapless receipt numbering — a requirement the SRS never states. |
| `docs/adr/0003-design-system.md` | The เหลี่ยมนอก design system and how it replaced Hope UI: the primitives under `src/components/ds/`, the `--ln-*` tokens, and why the retired theme must not come back. |
| `docs/adr/0004-credit-notes-and-refunds.md` | Reversing a paid sale: the credit-note series, the refund leg, and why money is signed by direction. |
| `docs/adr/0005-automatic-transfer-confirmation.md` | Closing a bill from the shop's own bank notification, and why the matcher refuses when it is not certain. |
| `docs/adr/0006-pickup-handover-code.md` | The pickup QR: a minted signed code that expires with the hold, why the PIN stays beside it, and what the queue-facing board must not show. |
| `docs/adr/0007-notification-outbox.md` | The notification outbox: written with the fact, sent by a worker the shop runs, and why a customer's code never goes to the shop's LINE group. |
| `docs/adr/0008-partial-refunds.md` | Per-line refunds: the note itemises, several notes per invoice, and why the closing note takes the remainder. |
| `docs/adr/0009-rate-limiting.md` | The limiter on the doors that need no session, and the one signed-in door that is counted: a token bucket, who a request is from, and why only the first refusal is written down. |
| `docs/adr/0010-member-accounts.md` | Customer accounts: a credential created at the counter, phone numbers unique across every role, and points that are shown but never edited. |
| `docs/adr/0011-counter-enrolment.md` | The till enrols its own customers: one route a role wider, a dialog over the bill rather than a screen, and the 403 that moved to `PATCH`. |
| `docs/adr/0012-shared-rate-limit-store.md` | The limiter's buckets as rows in the shop's own database: what a restart, a second process and an unreachable database each mean for a limit. |
| `docs/adr/0013-command-lists-checked-against-package-json.md` | The command lists as a gate: what counts as a document, why a mention is enough, and the prose it deliberately still leaves to a person. |
| `docs/adr/0014-product-photos-are-links.md` | Product photos as links to wherever the shop keeps its pictures: the allowlist in front of them, the share link that is read as the picture inside it, why `route:audit` stopped watching `<img>`, and what that gives up. |
| `docs/adr/0015-the-app-mark-is-supplied-artwork.md` | The platform mark as the shop's own artwork, committed: the letter that exists only as a tone (so a one-colour trace of it loses the letter), why the app icons are a resample rather than a drawing, and the plate the dark theme needs instead of a tint. |
| `docs/adr/0016-hosted-multi-tenant.md` | The rental as a hosted service: a schema per shop in one database, a control plane in `public`, a per-request seam with no default client, Google for the owner and phone-plus-password for the counter — and the invariants it deliberately does not spend. |
| `docs/adr/0017-a-call-number-rides-with-the-receipt.md` | The number a customer is called by: why it is a second series rather than the receipt's, and the day that resets inside the statement that bumps it. |
| `docs/adr/0018-the-board-that-calls-a-number.md` | The drink queue: a second state machine beside the order's status (because `completed` is what the money counts), the board the bar taps through, why only ready numbers reach the customer screen, and today as the board's horizon. |
| `docs/adr/0027-the-shop-says-whether-it-calls.md` | The switch that turns the call number and the drink queue off for a shop that does not call its customers: one boolean rather than a shop type, obeyed by the sale so every screen corrects itself, and honoured by a prepared device. |
| `docs/adr/0028-the-shop-says-whether-it-takes-pre-orders.md` | The switch that turns pre-orders off for a shop that prepares nothing: a second boolean rather than the other half of the queue's, refused where the order is placed so an open storefront is still answered, and why the board stays reachable for orders already placed. |
| `docs/adr/0019-the-till-sells-offline.md` | Selling with no connection: numbers lent in blocks so a browser can issue a gapless series, the safety quantity that replaces "never oversell", the day a bill belongs to, the replay that makes a device's queue idempotent — and the invariants that move out of the database, including the two stock constraints the shortage case needed relaxed. |
| `docs/adr/0020-a-customer-signs-in-with-google.md` | Customer identity: Google plus a phone, a taken number refused rather than linked, and the phone staying the key — amends ADR 0016 §4. |
| `docs/adr/0029-the-front-door-belongs-to-the-customer.md` | The one sign-in URL a person can be given: `/login` is the customer's door — Google, LINE, or phone and password — with the staff form folded behind one button, and `/shop` a redirect to it, so the domain root and every printed QR code land on the same screen. |
| `docs/adr/0030-a-customer-is-reached-on-line.md` | The LINE door and LINE notifications: binding a LINE account to a customer by OTP, consent as two facts (the customer's timestamp and the friend list the webhook keeps), the collection code riding the customer's own LINE or nothing, and the shop's group gaining the refund and dismissed-transfer facts — opens ADR 0007 decision 3 the way it asked to be opened. |
| `docs/adr/0031-the-build-picks-the-phone.md` | The build targets the phone a customer is holding: why Next 16's own baseline (Safari 16.4) shipped a page that rendered with every button dead on iOS 15, the measurement that found it, the gate that keeps it found, the translucent-colour layer that had to be written down as values for it, and runtime APIs as the one thing no syntax check can see. |
| `docs/adr/0021-the-electronic-receipt-is-generated.md` | The electronic receipt as an image generated from the order rather than a stored file, the last month as an access window, and a signed link for a walk-in. |
| `docs/adr/0022-page-access-is-a-fixed-role-matrix.md` | Which pages each role may see, as a fixed deny-by-default matrix rather than a per-shop setting. |
| `docs/adr/0025-a-member-offers-goods-on-their-own-account.md` | ฝากขายผ่านหน้าบัญชีของสมาชิก: the offer form is a panel in the member's own ฝากขาย tab, the session names the owner so there is no unmatched phone, a double tap is one offer, and only an owner turns an offer into a product with a share — the documents ride along as links. |
| `docs/adr/0026-the-counter-owns-its-own-rules.md` | Two rules that had been copied into a second place instead of asked for once: a staff pre-order cancel needs no supervisor (the PIN gated the *till's* void, which reverses money — a reservation is a shelf decision) but is still written to the trail with the employee named, and the Phase 1 deadline is stamped on the order rather than recomputed, so changing the timeout cannot re-date the orders already waiting. |
| `docs/adr/0023-consigned-goods-and-the-consignors-share.md` | ฝากขาย: an owner and a percentage on `products`, a payables ledger, the shop selling as principal, and the share of the net excluding VAT. |
| `docs/adr/0024-a-prepared-till-launches-without-the-network.md` | The cold launch: a prepared till keeps its own shell so it opens with no connection, what the worker may and may not cache (never the API), the drawer as the one thing a device may answer from memory, and offline navigation as a document load rather than a router change. |
| `docs/offline-till-spec.md` | Shipped prepared cash offline flow: durable storage, exclusive writer, borrowed numbers, ordered idempotent replay, original cashier/shift, local tickets, close/release and admin recovery; actual Chromium proof and explicit limits. |
| `docs/roadmap.md` | The next three efforts in order — the offline till to land, customer identity with electronic receipts and the role matrix, then consigned goods — and which document changes with each. |
| `docs/hosted-release-plan.md` | The order of work for the hosted rental: what each phase has to prove, which document changes with it, and the two blockers that are not code. |
| `docs/wongnai-pos-gap-analysis.md` | Where this stands against a commercial Thai POS, and the build order that follows. |

## Not built yet

Deferred deliberately, and listed here rather than discovered during service:

- **Customer sign-in with Google.** Decided in ADR 0020 (Google plus a phone, with the phone
still the identity). Built end to end: `/login` — the front door — offers **both doors side
by side** (the old address `/shop` redirects there, and the staff form folds behind one
tap below) — continue
with Google (which takes a phone number when it is a new account, and **refuses** a number
another customer or staff member already holds rather than linking, so a typed number can
never take a row) and the counter's phone-and-password. A first sign-in with a free number
makes a `member`, and a customer can **move their number** by proving the new one by OTP. The
one gap is the owner's **hosted signup door** (ADR 0016), which waits on the control plane that
does not exist yet: the shop's owner signs in today the same way staff do.
- **Electronic receipts.** Decided in ADR 0021 (an image generated from the order, the last
month downloadable, a signed link for a walk-in). Built end to end: the customer's own
**account screen** lists the last month's receipts and downloads each as a PNG drawn from the
order; a walk-in's signed link opens a printable **receipt page** with no session; and the
counter can hand one over — the till's receipt sheet mints a fresh link and shows a QR and URL
for the customer to scan, print or read down the phone.
- **Overtime approval and leave.** Attendance is recorded and measured, but there
  is no request/approve workflow on top of it, and no leave calendar.
- **Customer messages on LINE.** The shop's own group can be reached, but a
  customer's collection code cannot: a LINE push needs a LINE user id, and this
  system does not capture one. SMS/webhook reaches the customer's phone today.
  See ADR 0007 decision 3 — **built since, in the shape it left open** (ADR 0030): a
  customer can sign in with LINE, bind their own account by OTP, and receive their
  collection code on their own LINE; the shop's group keeps facts about orders. What
  is still not built is the LIFF surface and broadcast.
- **The hosted rental.** A shop signing itself up with Google and getting its own
  space on a box we run, instead of a shop installing this on its own machine. The
  direction is decided and written down (ADR 0016) and the order of work is
  `docs/hosted-release-plan.md`; nothing of it is built, so every install today is
  still one shop per deployment (ADR 0002 §1).
- **Multi-branch and a second register.** One shop per deployment, and receipt
  issuance serialises on the shop row (ADR 0002 §4) — correct for one till.
- **Storing a product image.** A photo is a link the shop pastes (ADR 0014) and it
  draws on the till tile, the storefront and the back office — but nothing here keeps
  the bytes: no upload, no file this deployment holds, no resizing of what the link
  returns, and a photo host that goes down shows placeholders. **The consignment offer form
  (ADR 0025) is the same trade one level up**: the photographs and paperwork a member
  attaches are links to whatever host they already keep them on, so `npm run backup` does
  not cover them either.
- **Production hardening:** RTL, and object storage. (Rate limiting and the
  audit-log viewer are in — see below.)
- **The offline till beyond the cold launch.** A prepared till now opens with no
  connection at all — shell, drawer and catalogue all from the device (ADR 0024) —
  and a rebooted machine is no longer an asterisk on every guarantee in ADR 0019.
  What is still not promised: an offline page outside the four the device prepared,
  offline PromptPay, member lookup or refunds, a second register, and RSC payloads
  (so a link inside a page body still fails offline, where the nav does not). The
  worker needs HTTPS or localhost, which `docs/homelab-deploy.md` already requires.
- **Waiting times as a report.** A walk-in ticket now records both when it was paid for
  and when the goods were ready (ADR 0018), so how long customers actually wait is a fact
  the database holds — and no screen or workbook reads it yet.
- **A reconciliation screen over a date range.** The dashboard reconciles *today*: what the bank confirmed against what closed a bill, with the transfers left over. Comparing a week or a month against a statement is still two screens; it is also still the only way to find a bill from last week by its number.
