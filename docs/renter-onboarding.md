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
5. **Print a test receipt** — make one 1 THB test sale (see §5), then reprint it
   from the dashboard to check alignment and paper width.

---

## 5. Every day

| Task | Where | Notes |
| --- | --- | --- |
| Start the day | `/pos` → เปิดลิ้นชัก | Enter the float (starting cash). A sale is refused without an open drawer, because cash that belongs to no drawer cannot be reconciled. |
| Sell | `/pos` | Scan or tap, choose the payment method, take the money, hand over change. |
| Pre-orders | `/pos/preorders` | Four columns: new → confirmed → ready → collected. A pre-order **reserves stock when it is placed**, so the stock is gone even before the customer arrives. |
| Handover | `/pos` → รับสินค้า | The customer's 4-digit PIN finds their order. |
| Clock in / out | `/pos/attendance` | One button. Hours are computed by the database. |
| Close the drawer | `/pos` → ปิดลิ้นชัก | Count the cash and type it in. The screen shows the expected amount and names any discrepancy as short, over, or balanced. |
| Refund a bill | `/pos` → คืนเงินบิลนี้, or `/admin/dashboard` → คืนเงิน on the row | Hands the whole bill back and issues a credit note. Always needs a supervisor PIN, even for the owner. |
| Reports | `/admin/reports` | Four Excel workbooks, per date range. |
| Roster & timesheet | `/admin/schedules` | Roster shifts per employee per day; the timesheet shows lateness and overtime. |

---

## 6. Money and tax — what to know

- **Shelf prices include VAT.** A 107.00 THB item is 100.00 net + 7.00 VAT. The
  customer pays 107.00. The breakdown appears on the receipt.
- **The rate is copied onto each sale.** If the rate changes, sales made before it
  keep the old rate on their receipts, forever. That is deliberate.
- **Receipt numbers never repeat and never skip.** Do not edit
  `shops.receipt_running_number` by hand. If you must, back up first and know that
  a gap in a receipt series is the thing an auditor asks about.
- **A refund issues a credit note.** One note per receipt, for the *whole* bill:
  the customer gets all the money back and every line goes back on the shelf.
  Returning one item out of three is not supported yet, so if a shop needs that,
  refund everything and ring the rest up again as a new sale.
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

---

## 7. Backups and upgrades

```bash
# Back up. Do this daily; it is one file.
pg_dump -h localhost -U pos_app pos_dev > backup-$(date +%Y%m%d).sql

# Upgrade to a newer version.
git pull
npm install
npm run db:deploy      # applies new migrations
```

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

---

## 9. What this version does not do

Recorded here so nobody discovers it during service:

- No partial refunds or per-line returns: a refund reverses the whole bill.
- No way to *send* a refund automatically — cash goes back out of an open drawer,
  or you transfer it yourself from your banking app.
- No customer-facing online ordering — members can pre-order from inside the app.
- No outbound SMS/LINE notifications; alerts are in-app and on-screen only.
- No product image upload, no shop logo upload (yet).
- No purchase orders / supplier management; stock arrives through the import or
  through an adjustment.
- No offline mode: the till needs the network it is served from.
- No rate limiting, no audit-log viewer screen.
