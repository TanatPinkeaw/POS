# Renter onboarding — from a fresh install to the first sale

This is the runbook for the person installing and running the shop. It assumes no
knowledge of the codebase. Everything here is done from a terminal once, then
from a browser every day after.

---

## 1. What you need

| | |
| --- | --- |
| A computer | Windows, macOS, or Linux. This machine is the till server. |
| [Node.js](https://nodejs.org) 22 or newer | `node --version` |
| [PostgreSQL 17](https://www.postgresql.org/download/) | `winget install --id PostgreSQL.PostgreSQL.17 --exact` on Windows |
| A browser | Chrome or Edge is what the screens are tested against |

Optional but normal for a shop: a USB or Bluetooth barcode scanner (it types the
barcode and presses Enter — nothing to configure) and a receipt printer.

---

## 2. Install — one command

```bash
npm install
npm run setup
```

`npm run setup` is idempotent: running it twice changes nothing. It:

1. writes `.env` with a generated database password and a generated session
   secret (it will never overwrite a password that already works);
2. asks for your PostgreSQL **superuser** password — used once, never stored;
3. creates the role `pos_app` and the databases `pos_dev` and `pos_test`;
4. applies every migration.

Then:

```bash
npm run dev
```

and open **http://localhost:3000**.

> **Putting this on a Linux server rather than the machine in front of you?**
> `npm run dev` is the developer's loop. For a box that has to come back after a
> reboot and be reachable from the tablet at the counter, see
> [`docs/homelab-deploy.md`](homelab-deploy.md) — the systemd units, the TLS the
> login needs before a second device works, and the daily backup timer. Both halves
> of that guide assume Linux with systemd.

> **No demo data is installed.** The installer deliberately stops before that,
> because a shop that is about to trade must not start with 30 fake products.
> Demo data is opt-in, and only ever on a throwaway database: `npm run db:seed:demo`.

---

## 3. First run — the setup wizard

Because no shop exists yet, the app sends you straight to `/setup`. Fill in:

| Field | Notes |
| --- | --- |
| Shop name | Printed on every receipt and in the sidebar. Thai is fine. |
| Branch | e.g. `สาขาแรก`. Appears on the receipt if set. |
| Registered for VAT? | If yes, the next two fields matter. |
| VAT rate | 7 for the current Thai standard rate. |
| Tax ID (13 digits) | Your เลขประจำตัวผู้เสียภาษี. Digits only; the database rejects anything else. |
| Receipt prefix | 2–4 letters, e.g. `RC`. Receipts become `RC-2026-000001`. |
| Administrator | Your own name, phone number, and a password of at least 8 characters. |

You can change every one of these later at **ตั้งค่า / Settings**. The wizard
closes permanently once the shop exists — a second attempt is refused, so nobody
can re-initialise a shop that is trading.

**Keep the administrator phone number and password.** There is no password-reset
email in this system; recovery is a SQL statement (see §8).

---

## 4. Before you open the till — the checklist

1. **Settings** (`/admin/settings`) — confirm the shop name, tax ID, VAT rate and
   receipt prefix. Check the *next receipt number* the screen shows.
2. **Staff** (`/admin/staff`) — create one account per person. Roles:
   - **employee** — sells, opens and closes a drawer, clocks in, works the
     pre-order board.
   - **admin** — everything, plus stock, catalogue, staff, settings, reports.
   The last administrator cannot be deactivated: the system refuses to leave a
   shop with nobody who can administer it.
3. **Categories** (`/admin/products`) — add the categories you actually think in.
   You may skip this: importing a sheet that names a category creates it.
4. **Catalogue** — the fastest way in is a spreadsheet. **Products → นำเข้าสินค้า**
   has a *download template* button. The header row must be one of these exact
   spellings (English aliases also work):

   | บาร์โค้ด | ชื่อสินค้า | หมวดหมู่ | ราคาทุน | ราคาขาย | จำนวนสต็อก |
   | --- | --- | --- | --- | --- | --- |
   | `8850999112233` | กาแฟคั่วบด 250 ก. | เครื่องดื่ม | 95 | 140 | 24 |

   - Upload → the screen shows **what the file would do**, row by row, including
     rows it would reject and prices it would overwrite. Nothing is written yet.
   - Confirm → it is applied in one transaction.
   - `จำนวนสต็อก` is the count on the shelf **now**. It is *added* to stock and
     recorded in the stock history — it is not an overwrite, so importing the same
     file twice adds the stock twice. Import once.
   - A row with a problem is skipped and reported; the rest of the file still goes in.
   - `URL รูปภาพ` (optional) is a **link**, not a file: paste the https link of a
     picture the shop already keeps somewhere backed up. See §9 for what "link"
     means here.
5. **Print a test receipt** — make one 1 THB test sale (see §5.1), then reprint it
   from the dashboard to check alignment and paper width.

---

## 5. Every day

| Task | Where | Notes |
| --- | --- | --- |
| Start the day | `/pos` → เปิดลิ้นชัก | Enter the float (starting cash). A sale is refused without an open drawer, because cash that belongs to no drawer cannot be reconciled. |
| Sell | `/pos` | Scan or tap, choose the payment method, take the money, hand over change. |
| Pre-orders | `/pos/preorders` | Four columns: new → confirmed → ready → collected. A pre-order **reserves stock when it is placed**, so the stock is gone even before the customer arrives. |
| Handover | `/pos/preorders` → ค้นหา | **Scan the customer's QR**, or type their 4-digit PIN, or their phone number — one box takes all three. The QR is on the customer's own order screen, under that order. The dialog that opens lists each line with the product's photo (if you gave it one), which is how you tell which bag on the shelf is this order's. |
| Clock in / out | `/pos/attendance` | One button. Hours are computed by the database. |
| Close the drawer | `/pos` → ปิดลิ้นชัก | Count the cash and type it in. The screen shows the expected amount and names any discrepancy as short, over, or balanced. |
| Refund a bill | `/pos` → คืนเงินบิลนี้, or `/admin/dashboard` → คืนเงิน on the row | Tick the lines coming back and how many of each — or leave it blank to hand the whole bill back. The credit note itemises exactly what it reverses, and the customer can come back later for the rest. Always needs a supervisor PIN, even for the owner. |
| Product photos | `/admin/products` → **รูปสินค้า** | Paste an https link to a picture you already keep (your Nextcloud, your hosting) — there is a live preview, and an empty box removes the photo. The same link appears on the till tile and in the shop's catalogue. Nothing is uploaded: see §9. |
| Reports | `/admin/reports` | Four Excel workbooks, per date range. |
| Roster & timesheet | `/admin/schedules` | Roster shifts per employee per day; the timesheet shows lateness and overtime. |
| Enrol a customer | `/pos` → *สมัครสมาชิกใหม่*, or `/admin/members` | Name, phone number and a temporary password you read to them. At the till it opens as a dialog **over the bill**: the basket is not lost, the number you just searched for comes with you, and the customer is attached to that bill when it closes — so enrolling somebody mid-queue does not stall the sale. The phone number is what they sign in with, so ask before you type — and it must not be one a staff account already uses. |
| Check what happened | `/admin/audit` | Every gated action, newest first: who was at the till, whose PIN approved it, the amounts and the reasons. Nothing here can be edited or deleted, including by us — filter by action or by person. |

### 5.1 The first sale, end to end

The table above is the daily view. This is the same thing once, slowly, because the
first sale is where a wrong receipt prefix, an unplugged printer or a missing VAT
registration gets found — and all three are cheap to fix before the shop is busy.

1. `/pos` → **เปิดลิ้นชัก** and type the float you are starting with. Nothing can be
   sold before this: cash that belongs to no drawer cannot be reconciled.
2. Scan a barcode or tap the product. The bill fills on the right, VAT already inside
   the shelf price.
3. Optional, and both are the same box on the bill: **ค้นหา** by phone number to attach
   the customer, or **สมัครสมาชิกใหม่** to enrol one without leaving the sale.
4. **รับชำระเงิน**. Choose **เงินสด**, **พร้อมเพย์** (a QR appears, locked to the bill's
   amount), or **แบ่งจ่าย** for a transfer plus the rest in notes — a part-paid bill
   computes the change against the cash share only. **ยืนยันรับเงิน** closes it.
5. **พิมพ์ใบเสร็จ** and read the paper: the shop name (and the branch, if you set
   one), the receipt number, your tax ID and the VAT line if the shop is registered,
   then the total. This is the moment to go back to Settings and fix the receipt prefix
   if it is wrong.
6. Rung the wrong bill? **คืนเงินบิลนี้** on the receipt — tick the lines coming back, or
   leave them blank to hand the whole bill back. A refund always asks for a supervisor
   PIN and a reason: set the PIN at `/admin/staff` before the first shift, because
   until one exists every refund is refused, including the owner's.
7. End of the day: **ปิดลิ้นชัก**, count the notes and coins, and type the total in. The
   screen names any difference as short, over or balanced, and it stays on the record.

---

## 6. Money and tax — what to know

- **Shelf prices include VAT.** A 107.00 THB item is 100.00 net + 7.00 VAT. The
  customer pays 107.00. The breakdown appears on the receipt.
- **The rate is copied onto each sale.** If the rate changes, sales made before it
  keep the old rate on their receipts, forever. That is deliberate.
- **Receipt numbers never repeat and never skip.** Do not edit
  `shops.receipt_running_number` by hand. If you must, back up first and know that
  a gap in a receipt series is the thing an auditor asks about.
- **A refund issues a credit note, and the note itemises what it reverses.** Tick the
  lines coming back and how many of each — only those go onto the note and back onto
  the shelf. Leave them blank to hand the whole bill back. One sale can collect several
  notes over time, numbered 1, 2, 3 within the bill, and the invoice itself is never
  rewritten: a partly-credited bill still reads as the bill that was issued, and only
  becomes *refunded* once the notes have taken back everything on it.
- **Credit-note numbers are gapless too, and separate from receipts.** They live
  in their own series (`CN-<year>-000001`), so a refund never consumes a receipt
  number and vice versa. Do not edit `shops.credit_note_running_number` by hand.
- **Money only comes out of an open drawer, or out of your own bank app.**
  Refunding in cash with no drawer open is refused — open one first. If you
  transferred the money back from your banking app instead, record the refund as
  a transfer: that way it does not pretend to have come out of the till.
- **Every refund needs a supervisor PIN and a reason.** The reason is printed on
  the credit note and cannot be skipped; it is the only written record of why the
  money left.
- **Loyalty points are reversed, but never to a negative balance.** If the
  customer already spent the points that purchase earned, the refund still goes
  through and the difference is shown on the credit note as forgiven. The refund
  is never blocked by points.
- **Still ask your accountant.** The credit-note layout follows the usual Thai
  format, but whether it satisfies the Revenue Department is their call.

### 6.1 Letting a transfer close its own bill

When a customer pays by PromptPay, the till shows a QR and waits. Somebody then
has to tell the system the money actually arrived — normally the cashier, by
looking at the shop's banking app and entering a supervisor PIN. If your bank
emails you when money comes in, a small script shipped with this software can do
that for you instead, for nothing:

1. In `/admin/settings`, fill in **พร้อมเพย์** with the number or tax id the shop
   receives on. The till can then issue a QR locked to the bill's amount.
2. Put the bank's notification mailbox and the amount pattern into `.env` — see
   `BANK_IMAP_*`, `BANK_NOTIFICATION_FROM` and `BANK_AMOUNT_REGEX` in
   `.env.example`. The pattern is the only bank-specific part; test it against a
   real notification before trusting it:
   `npm run bank:bridge -- --file ./notification.eml`
   Set `BANK_NOTIFICATION_FROM` to the bank's address unless you made a mailbox
   only for these notifications — otherwise other unread mail gets filed as money
   the system could not read.
3. Run the bridge on something always on:
   `npm run bank:bridge -- --interval 60`

What it does *not* do, so nobody is surprised: it never guesses which bill a
transfer paid. It needs the amount to match a QR exactly **and** the notification
to quote that QR's reference, which the customer types into their memo. A transfer
it cannot match is not lost — it appears on the dashboard under *เงินโอนที่ยังจับคู่กับบิลไม่ได้* —
with the reason, and an admin closes it with a note once they know what it was.

Money only ever leaves through an open drawer or by hand in your banking app; this
script never sends anything out. If your bank does not send notification email,
keep confirming transfers by hand with a supervisor PIN — nothing else breaks.

### 6.2 Telling people things outside the browser

By default everything is in the app: the board chimes, the customer's order screen
updates live, and if nobody is looking at a screen then nobody hears. If you want a
message to actually leave the shop:

1. Put `NOTIFY_CHANNEL` and your destination in `.env` — see the note under
   `NOTIFY_CHANNEL` in `.env.example`.
   - `NOTIFY_CHANNEL="line"` with `NOTIFY_STAFF_TO` = your LINE group id. This
     reaches the *shop*. A LINE group cannot reach a customer, so collection codes
     are never sent this way.
   - `NOTIFY_CHANNEL="webhook"` with `NOTIFY_WEBHOOK_URL` = your SMS gateway or a
     small script of your own. This is the one that reaches a **customer's phone**,
     and the shop's own messages go to `NOTIFY_STAFF_TO`.
2. Run the worker on something always on: `npm run notify:worker -- --watch` (or
   `npm run notify:worker` from cron once a minute).

Two messages go out: the shop gets a note when a pre-order arrives, and the
customer gets their pickup PIN and hold deadline when their parcel is packed. Set
nothing and nothing is queued — the app keeps working exactly as it does now.

If your gateway stops accepting messages, the worker retries on a schedule (about
1, 5, 15, 60 and 360 minutes) and then **gives up**, leaving the reason from your
provider on the dashboard under *ข้อความแจ้งเตือนที่ส่งไม่ออก*. That is a
configuration problem, not a lost order: the order itself is unaffected, and the
customer still sees everything in the app.

---

## 7. Backups and upgrades

```bash
# Back up. Do this daily; it is one file.
npm run backup          # add -- --list to see what is already there

# Upgrade to a newer version.
git pull
npm install
npm run db:deploy      # applies new migrations
```

`npm run backup` writes a compressed dump of the shop's database and drops anything
older than 14 days. It reads the connection out of `.env` itself, so there is no
password to type and nothing to remember, and the dump is plain SQL, so `gunzip | psql`
is all a restore needs. By default it writes into `backups/` beside the checkout — which
is the same disk as the database, so it says so, and `-- --dir /srv/pos-backups` (or
`BACKUP_DIR`) is how you point it at another disk and copy that somewhere else. If this
machine is the one that serves the shop, `docs/homelab-deploy.md` §7 turns the same
command into a nightly timer that writes to `/var/backups/pos`, and has the restore
drill; **run that drill once before you need it.**

It is the **database only** — and that is worth knowing before you rely on it. Product
photos are links to the shop's own file host (ADR 0014), not rows, so nothing here
dumps them: they are covered by whatever backs that host up. For the reference
installation the pictures live in the homelab's Nextcloud, so its backup is what stands
between the shop and a catalogue of placeholders.

Use **`npm run db:deploy`** (`prisma migrate deploy`), never `prisma migrate dev`.
Parts of the schema — the `work_hours` generated column, several `CHECK`
constraints, the order-number sequence — exist only in hand-written migration SQL
that `migrate dev` would propose dropping.

---

## 8. When something is wrong

| Symptom | Cause and fix |
| --- | --- |
| `EADDRINUSE` on start | Another process holds port 3000. Set `PORT=3001` in `.env`. |
| Typography or icons look wrong / slow first paint | Historically the app fetched its font from Google. Installations should be offline-capable; if text still renders in a fallback font, check the browser console for blocked requests. |
| `Could not find psql` during install | PostgreSQL is installed somewhere unusual. Add its `bin` directory to `PATH` and re-run `npm run setup`. |
| The wizard says the system is already set up | Correct — a shop row exists. It will not re-initialise. To start over on a *throwaway* database only: `DELETE FROM shops;` then reload `/setup`. |
| Forgot the administrator password | Reset it from the database, replacing the phone number and hash. Generate a hash, then: `UPDATE users SET password_hash = '<hash>' WHERE phone = '08xxxxxxxx';` |
| A sale is refused with "drawer is not open" | Open the drawer first (`/pos` → เปิดลิ้นชัก). This is deliberate: cash must belong to a drawer. |
| Imported stock twice | Stock was added twice, as documented. Correct it with a stock adjustment (`REASON_CORRECTION`) so the audit trail explains it. |
| Signing in works on this machine but not on a tablet | The production session cookie is `Secure`, so it is only stored over `https://` — browsers exempt `localhost`, which is why the server itself works and the tablet does not. The deployment needs a secure URL; see `docs/homelab-deploy.md` §4. |
| `pg_dump: command not found` from `npm run backup` | Only the PostgreSQL client is missing: `apt install postgresql-client-17` for a 17 server (the plain package is usually a version behind, which fails differently — `aborting because of server version mismatch`). Windows gets one with the PostgreSQL installer. |
| The app is not running after a reboot | Nothing starts it yet. `docs/homelab-deploy.md` §3 installs it as a service that comes back on its own. |

---

## 9. What this version does not do

Recorded here so nobody discovers it during service:

- No way to *send* a refund automatically — cash goes back out of an open drawer,
  or you transfer it yourself from your banking app.
- No customer-facing online ordering — members can pre-order from inside the app.
- Notifications are off until you configure a channel (§6.2), and a LINE channel
  reaches the shop's own group only — not a customer's phone.
- **No image upload.** A product photo is a *link* (ADR 0014): you paste the https
  link of a picture that already lives somewhere, and this system draws it on the
  till, the shop's catalogue and the back office. It cannot hold the file, resize it
  or check what is at the other end — a link that returns a login page shows a
  placeholder — and **the picture is not in `npm run backup`**, because it is not in
  this database. Whatever backs up the place you keep the picture is what protects it.
  A link to your file host's *preview* is better than one to the original file: the
  host then does the resizing. The shop logo is the same idea, set in
  `/admin/settings`.
- No purchase orders / supplier management; stock arrives through the import or
  through an adjustment.
- No offline mode: the till needs the network it is served from.
- No rate limiting on anything you are *signed in* to, with one exception:
  **enrolling customers**. Signing in, the supervisor PIN, the setup wizard,
  display pairing and the bank webhook are counted because they need no session;
  enrolling is counted because each one hands out an account that can reserve stock
  without paying for it. Ten in a row, then one a minute, and the budget belongs to
  the account — so a colleague at the next till is unaffected, and signing out does
  not reset it. Nothing a person types reaches ten. A password typed wrong ten
  times in a quarter of an hour still makes you wait, one account at a time.
