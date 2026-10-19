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

**Signing in.** The shop's sign-in page is the customer's door first: customers sign in there
with **Google** or the **phone number and password** you enrolled them with (this page is also
what a printed QR opens — the old address `/shop` still works and sends them to the same
place). Staff sign in on the same page: tap **พนักงานเข้างาน** at the bottom and the staff
form opens. Demo accounts, on a freshly seeded database, are listed inside that same fold.

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

   The big number above everything else is the **call number** — the number you shout
   when the drink is ready. It starts at 1 every morning and goes up all day, the same
   in a shop that is registered for VAT and one that is not, and it is not the invoice
   number beside it: the invoice number is the document's name and never resets. A
   reprint of a bill carries the same call number as the slip in the customer's hand.

   Then open **คิวเครื่องดื่ม** (`/pos/queue`): every bill you have just closed is on it,
   under **กำลังทำ**, with its number and what has to be made. Tap **เสร็จแล้ว** when the
   drink is done and the number moves to **พร้อมรับ** and appears on the customer screen —
   that is the moment you call it out. Tap **รับแล้ว** as you hand it over and it leaves
   the board. The board only ever shows today: anything left on it is gone at midnight,
   so a slip that was never collected does not sit on the screen in front of tomorrow's
   customers.
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

### 6.0 A customer wants their receipt on their phone

Two ways to give one, and they are for different customers.

- **A customer with an account** signs in and opens **บัญชีของฉัน → ใบเสร็จ**. The row says
  **ดูใบเสร็จ** and opens the slip on their screen. Under it there is one button, and which
  one depends on the phone, not on you: **แชร์ / บันทึก** opens the phone's own share sheet
  (the customer taps “บันทึกไปยังรูปภาพ”), **บันทึกเป็นรูป** saves the picture on a computer,
  and a phone whose browser cannot save files at all shows the picture with “กดค้างที่รูป” —
  press and hold, then save. If a customer says "the button does nothing", they are most
  likely on a phone where the old download button was silently ignored; ask them to press
  and hold the picture instead. That is what the screen offers them now.
- **A customer with no account** gets a **link** from the till: on the receipt, mint the
  link and show the QR. It opens the same slip with no sign-in and can be printed, shared or
  saved from there.

Both are readable for **one month** after the sale. After that the bill still exists and can
be reprinted from `/admin/sales` — the customer's own copy closes, the shop's records do not.

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
     reaches the *shop* — and, once your customer has bound their own LINE
     (§6.3), their "order ready" message and collection code reach their own LINE
     instead of only the app. A collection code is never pushed to the group.
   - `NOTIFY_CHANNEL="webhook"` with `NOTIFY_WEBHOOK_URL` = your SMS gateway or a
     small script of your own. This is the one that reaches a **customer's phone**,
     and the shop's own messages go to `NOTIFY_STAFF_TO`.
2. Run the worker on something always on: `npm run notify:worker -- --watch` (or
   `npm run notify:worker` from cron once a minute).

The **shop** hears about the things an owner otherwise learns late: a new pre-order,
a refund, a bank notification dismissed by hand on the dashboard, and a customer
writing in. The last one is capped on purpose — the group is told **once per
customer per ten minutes**, however many messages they send in that time (§6.3).

A **customer** hears about their own order, on LINE, at most five times: when staff
accept it, when it is packed (the PIN and the hold deadline), once shortly before
the hold ends, if the shop cancels it, and after handover with a receipt link that
says how long the link lasts. A customer who cancels their own order is not told —
they just did it. The reminder's lead time is `PICKUP_REMINDER_HOURS` (3 by
default; `0` turns it off).

Set nothing and nothing is queued: the app keeps working exactly as it does now,
and the customer reads the code on their own order screen.

**The one setting people get wrong.** All five customer messages need
`NOTIFY_CHANNEL="line"`. A push token alone is not enough, and a shop on
`NOTIFY_CHANNEL="webhook"` gets its own alerts by SMS but sends **no** LINE message
to customers. Nothing errors when this is wrong — the message is simply never
planned, so there is no failed row to find. To see which door is shut:
`npm run line:wizard -- --verify` on the machine, or open `/admin/line` while the
server runs (it reads the settings the server is actually using — after editing
`.env`, restart it). At the counter, the pre-order card also says whether that
customer was told, or why not; "ยังไม่ได้เพิ่มเพื่อนร้าน" is the usual answer.

`NOTIFY_CHANNEL` decides where the *shop's own* messages go. Sending a **promotion**
to your customers is a different switch: it needs `NOTIFY_LINE_TOKEN`, and it works
even if your own alerts go to a webhook or nowhere at all (§6.3).

### 6.3 LINE: signing in, binding, and being told on LINE

Your customers live on LINE, so the system can meet them there. Three parts, all
optional and independent of everything above:

- **Sign in with LINE.** On the sign-in page (`/login`) a customer can continue
  with LINE, give their phone number once, and receive a code to prove the number
  is theirs. From then on that LINE account opens their customer account — points,
  orders and receipts — exactly as the phone or Google does. One LINE account
  belongs to one customer, forever; a staff phone number is refused outright. One
  thing to know when a customer says a button is missing: LINE opens pages in its
  own in-app browser, and **Google refuses to sign anyone in there** — that is
  Google's rule, not ours. Tell them to tap **เข้าสู่ระบบด้วย LINE** (which works
  inside LINE), or to open the page in Safari/Chrome and use the Google button.
  The LINE button **signs a customer in**: an account already linked opens their
  account straight away, and one that is not yet linked is asked for the phone
  number and a code before anything is attached. If LINE sends them back to the
  sign-in page, the page says which of these happened and what to do — the
  confirmation expired (press the button again), the account is closed or is a
  staff account (a counter conversation), or that LINE account already belongs to
  another customer. Only the first two are things the customer can fix alone. One
  phone-only case is handled without anyone noticing: a phone whose LINE app was
  supposed to open itself and hand the sign-in back sometimes cannot finish it, and
  the system answers that by sending the customer straight to LINE's own sign-in
  screen once with automatic login switched off — so they sign in with LINE there
  (or type their LINE email and password, if the browser does not offer that) and are
  in. If the page still says the sign-in failed *after* that, it is a
  channel setting rather than the customer: `npm run line:wizard -- --verify` says
  which.
- **Bind from the account page.** A customer already signed in opens
  `/shop/account` → **LINE** → ผูกบัญชี LINE, which walks them through LINE's own
  consent screen and back. No code needed — they are already signed in.
- **Being told on LINE.** After binding, the same card asks whether they consent to
  notifications. One more thing is on them, and the card says it plainly: they must
  **add the shop as a friend** on LINE, or no message can arrive — that is LINE's
  rule, not ours. ยกเลิกการผูก on that card stops everything at once: no more
  messages, and the LINE account no longer opens the account.
- **Opening the shop inside LINE.** Once you have registered an entry (step 5
  below), the "รับของได้แล้ว" message carries a link, and tapping it opens the shop
  **inside LINE** — the customer is already signed in, and sees the catalogue,
  their orders and their receipts without typing anything. A customer who has never
  used the shop this way is asked for their phone number and a code once, in that
  same page, and then they are in. If somebody opens that link in Safari or Chrome
  instead, it says in Thai that it only works in the LINE app and points at the
  normal sign-in page — that is not a fault, it is the link being opened somewhere it
  was not meant for.
- **What your customers say back.** Anything a customer types or sends to the shop's
  LINE is kept, with the customer it came from, and appears on their card under
  **ลูกค้า** (`/admin/members`) beside their points and orders. Your phone's own LINE
  app already shows you the message; this is what tells you *which customer* it was
  and lets you look them up. A photo, a sticker or a voice note is recorded as the
  kind of thing it was, without keeping the picture itself. Answer in LINE as you
  always would — the shop's LINE screen is not a chat window.

**Promotions.** You can send one message to all of your customers at once, from
**โปรโมชัน LINE** (`/admin/line`). Only customers who did three things get it: bound
their LINE, added the shop as a friend, and **agreed to receive promotions** — which
is a separate yes from "tell me about my order", offered on the customer's own LINE
card, and never assumed. The screen tells you how many customers that is and what the
send costs before you press anything.

That cost is the thing to keep an eye on. LINE counts every recipient as one message
against the month's allowance — **300 messages a month on the free plan** — and so does
a message to the shop's own group: one message per member of the group, every time. Send
to 250 customers and you have spent 250 of your 300. The screen reads the month's
remaining allowance from LINE and refuses a send that will not fit, but LINE itself is
the authority: if it refuses anyway (`You have reached your monthly limit.`), that is
what the campaign shows afterwards. Sending is admin-only, and the same screen lists
what has been sent and what could not be sent.

**When a send does not fully go out.** A campaign goes to LINE in batches of up to 500
customers, and each batch is tried **once**. If LINE refuses one, that campaign is shown
as **ส่งไม่ครบ (partial)** with LINE's own words beside the failed batch: some customers
got it and some did not, and only a person can decide what to do next. Nothing is
retried automatically, because LINE cannot tell a retry from a fresh send and a promotion
delivered twice is worse than one that did not arrive. If you want to reach the leftovers,
write and send a **new** campaign — the old one keeps saying what actually happened.

What you must do once, as the shop owner (the wizard walks you through it):

1. Create an **Official Account** for the shop at https://account.line.biz, then
   in https://developers.line.biz create **two channels** under it: a **Messaging
   API** channel and a **LINE Login** channel.
2. From the Messaging API channel take the **channel access token** (this is
   `NOTIFY_LINE_TOKEN`) and the **channel secret**
   (`LINE_MESSAGING_CHANNEL_SECRET`); from the LINE Login channel take the
   **channel ID and secret** (`LINE_LOGIN_CHANNEL_ID`,
   `LINE_LOGIN_CHANNEL_SECRET`).
3. Register two URLs with LINE — the callback on the LINE Login channel and the
   webhook on the Messaging API channel. Both are your system's own address plus
   `/api/v1/auth/line/callback` and `/api/v1/line/webhook`.
4. `npm run line:wizard` collects all of this into `.env`, and
   `npm run line:wizard -- --verify` later tells you which doors are open.
5. For the in-LINE entry, add a **LIFF app** — in the **LINE Login** channel (not
   the Messaging API one), under the *LIFF* tab — and set its **endpoint URL** to
   your system's own address plus `/line`. It has to be `https://`; LINE will not
   accept a plain-HTTP address. Copy the **LIFF ID** it gives you into
   `LINE_LIFF_ID` (the wizard asks for it) and restart. Without it, `/line` says the
   shop has not set the entry up and points at the normal sign-in page, and the
   "ready" message simply carries no link.

6. Optional, and **not part of this system**: a **rich menu** — the three buttons a
   customer sees under the chat. It is a picture plus three tap areas that you send to
   LINE yourself through the Messaging API, and none of your screens know it exists,
   so there is no button in the back office for it. Before you try: the image must be
   **2500×843**, the tap areas are read off the picture itself (the drawn dividers sit
   at x=832 and x=1666 of 2500), Thai text has to be sent from a file rather than typed
   on a command line (Windows turns it into `?`), and **sending it again makes a second
   menu** rather than changing the first. `docs/adr/0033-the-shop-has-a-rich-menu.md`
   records what a live one looks like, and the id to delete if you want to start over.

If messages stop arriving after a customer changed phones or removed the shop as a
friend, it is almost always the friend condition: they re-add the shop as a friend
and everything resumes — their consent was never withdrawn.

If your gateway stops accepting messages, the worker retries on a schedule (about
1, 5, 15, 60 and 360 minutes) and then **gives up**, leaving the reason from your
provider on the dashboard under *ข้อความแจ้งเตือนที่ส่งไม่ออก*. That is a
configuration problem, not a lost order: the order itself is unaffected, and the
customer still sees everything in the app.

### 6.4 Google: letting a customer sign in with their Google account

Also optional, and also on the sign-in page: **ดำเนินการต่อด้วย Google**. The
customer approves the shop with their Google account, gives a phone number once,
and that number is their account from then on — their points, orders and receipts.
A number that already belongs to a customer is **refused rather than taken over**;
that person signs in with the phone number and password you enrolled them with.

What you must do once, as the shop owner:

1. In https://console.cloud.google.com create an **OAuth 2.0 Client ID** of type
   **Web application**.
2. Give it **two** addresses, both your system's own public address (the same one
   `PUBLIC_BASE_URL` names — see §3):
   - under **Authorized JavaScript origins**, just the address, for example
     `https://pos.example.com`;
   - under **Authorized redirect URIs**, the address plus
     `/api/v1/auth/google/redirect`, for example
     `https://pos.example.com/api/v1/auth/google/redirect`.
3. Put the client ID in `.env` as `GOOGLE_CLIENT_ID` and restart the app.
4. Check the entry with `npm run google:check` — it asks Google directly whether the
   address your button sends is registered, and prints the exact line to paste if it is
   not. After changing the console entry, wait a moment (Google says five minutes to a
   couple of hours) and run it again.

Both entries matter, and each is for a different kind of device. A **computer**
uses the first one. A **phone** uses the second, because Google will not hand a
phone's browser a sign-in through the small pop-up window — Apple's browser blocks
it — so the phone is sent to Google's own page and comes back to that address. **If
the button works on your computer and not on your phone, that is the missing entry**
and Google shows its own error page instead — "การเข้าถึงถูกบล็อก: คำขอของแอปนี้
ไม่ถูกต้อง" with "ข้อผิดพลาด 400: redirect_uri_mismatch" on it. Your own system sees
nothing at all when that happens, which is why the screen the *customer* photographed
is the only clue; `npm run google:check` is the way to ask the same question without
waiting for one. Add the line it names and nothing else needs changing. Leave
`GOOGLE_CLIENT_ID` unset and the door stays on the page but says the shop has not set
it up yet.

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
| A customer sees no menu under the shop's chat | The menu is LINE's own object rather than something this app serves, so if nobody ever sent one, there is none — and there is no button in the back office that makes one (`docs/adr/0033-the-shop-has-a-rich-menu.md`). If one was sent and still does not show, ask them to close and reopen the chat: LINE caches the menu. |
| Opening the LINE callback address in a browser lands on the sign-in page and says nothing | Correct, and not a broken sign-in. That address only answers LINE's own redirect (`§6.3`); with no code, no state and no error on it there was no sign-in to report, so it reports none. The button on `/login` is what begins one. |
| A sale is refused with "drawer is not open" | Open the drawer first (`/pos` → เปิดลิ้นชัก). This is deliberate: cash must belong to a drawer. |
| The till shows a bar reading **โหมดออฟไลน์**, and a sale is refused with "ต่อเน็ตก่อนขาย" | The till cannot reach its server: the shop's connection dropped, the router is down, or the machine this runs on was restarted. Check the till's own network first, then `docs/homelab-deploy.md` §4. Cash still works on a till that was **explicitly prepared** while online (§10) — that is the whole point of preparing before an outage. A till that was never prepared refuses the sale instead of failing silently, and the refusal names what is missing, because it has no catalogue or numbers on the device. |
| Imported stock twice | Stock was added twice, as documented. Correct it with a stock adjustment (`REASON_CORRECTION`) so the audit trail explains it. |
| Signing in works on this machine but not on a tablet | The production session cookie is `Secure`, so it is only stored over `https://` — and `localhost` is exempt unevenly: Chromium stores and sends it there, Safari/WebKit only stores it and never sends it back. That is why the server itself works and the tablet does not. The deployment needs a secure URL; see `docs/homelab-deploy.md` §4. |
| **Google** sign-in works on the computer but not on a phone | A phone is sent to Google's own page and comes back to the redirect URI, which is a **separate entry** from the JavaScript origin (§6.4). Add the address plus `/api/v1/auth/google/redirect` under *Authorized redirect URIs* in the OAuth client. Google shows its own error page about the redirect URI when it is missing. |
| `pg_dump: command not found` from `npm run backup` | Only the PostgreSQL client is missing: `apt install postgresql-client-17` for a 17 server (the plain package is usually a version behind, which fails differently — `aborting because of server version mismatch`). Windows gets one with the PostgreSQL installer. |
| The app is not running after a reboot | Nothing starts it yet. `docs/homelab-deploy.md` §3 installs it as a service that comes back on its own. |

---

## 9. What this version does not do

Recorded here so nobody discovers it during service:

- No way to *send* a refund automatically — cash goes back out of an open drawer,
  or you transfer it yourself from your banking app.
- No customer-facing online ordering — members can pre-order from inside the app.
- Notifications are off until you configure a channel (§6.2). With LINE configured
  the shop's group gets facts about orders, and — after your customer binds their own
  LINE (below) — the "order ready" message and collection code reach the customer's
  own LINE. A code is never pushed to the group.
- **No image upload.** A product photo is a *link* (ADR 0014): you paste the https
  link of a picture that already lives somewhere, and this system draws it on the
  till, the shop's catalogue and the back office. It cannot hold the file, resize it
  or check what is at the other end — a link that returns a login page shows a
  placeholder — and **the picture is not in `npm run backup`**, because it is not in
  this database. Whatever backs up the place you keep the picture is what protects it.
  A link to your file host's *preview* is better than one to the original file: the
  host then does the resizing. The shop logo is the same idea, set in
  `/admin/settings` → **โลโก้ร้าน**: the same field and the same live preview, and it
  refuses a link it cannot open. It appears on the customer screen (`/display`) while
  the shop is idle — it is not printed on the receipt.
- No purchase orders / supplier management; stock arrives through the import or
  through an adjustment.
- **No cold offline start.** Cash works on an already-loaded, explicitly prepared
  till; opening a new page with no connection does not. Offline PromptPay, member
  lookup/points, pre-orders and refunds are not supported. See the procedure below.
- No rate limiting on anything you are *signed in* to, with one exception:
  **enrolling customers**. Signing in, the supervisor PIN, the setup wizard,
  display pairing and the bank webhook are counted because they need no session;
  enrolling is counted because each one hands out an account that can reserve stock
  without paying for it. Ten in a row, then one a minute, and the budget belongs to
  the account — so a colleague at the next till is unaffected, and signing out does
  not reset it. Nothing a person types reaches ten. A password typed wrong ten
  times in a quarter of an hour still makes you wait, one account at a time.

## 10. Prepare the till before a network outage

1. Use Chrome/Edge on **HTTPS or localhost**, normal browser storage, and only one
   selling tab. Open the drawer while connected. Do not use private browsing or
   clear site data while the till holds bills or numbers.
2. Choose **เตรียมเครื่องขายออฟไลน์**, enter **ชื่อเครื่อง**, read the warning and
   confirm. Preparation downloads the active catalogue in pages and borrows 200
   invoice numbers (VAT shops) plus 200 call numbers each for today and tomorrow.
   Check the **แคช** item count/time and remaining numbers before relying on it.
   If preparation is interrupted, use the same device/account to retry or send/release;
   the persisted request identity recovers an uncertain borrow.
3. The prepared till is **cash-only without members even online**. For ordinary
   PromptPay, points/member or approved over-limit discounts, choose **ส่งบิลและ
   คืนชุดเลข** first. Do not prepare a second device: the borrowed series is frozen
   elsewhere, and this is not multi-register support.
4. During an outage, stay on this loaded page. Search/scan the cached products and
   take cash normally. **ยืนยันรับเงิน** succeeds only after the local transaction
   commits. A storage error means **do not confirm receipt of money**: check the
   device, do not keep pressing or clear its data. Pending money is not yet in the
   server drawer figure. The **คิวในเครื่อง** buttons **เสร็จแล้ว / รับแล้ว** record
   the local ticket; the customer display and other queue screens remain stale.
5. **กันออฟไลน์** on the product row is the quantity kept back from the device's
   snapshot. It does not reserve shelf stock against pre-orders/online sales. The
   offline promise is weaker; replay accepts goods already handed over, and stock
   disagreement becomes **สต็อกติดลบ — ต้องนับของจริง** on the admin dashboard.
6. When connected, sending is automatic (reconnect/ten-second timer with retry
   backoff); **ส่งบิลตอนนี้** retries immediately. A refused bill stays on the device
   with its reason; later bills are not skipped. Keep the **same cashier account
   and original drawer** until all bills have sent. Never delete a refused bill.
7. Before normal **ปิดลิ้นชัก**, stop taking payments, reconnect and let the till
   send every bill and return unused numbers. A failure leaves the drawer open.
   The server also refuses a close while that cashier holds an open loan. If invoice
   numbers run out, send/release while online and prepare again; at a year boundary
   return the old invoice set and prepare a new one before selling.
8. If the old device can never return, an admin uses **ชุดเลขออฟไลน์ที่ยังไม่คืน**
   → **ตรวจและคืนชุดเลข**. Stop that device from selling, inspect **every actual
   printed document**, enter the last printed number (blank only if none ever
   printed), and check the evidence confirmation. The server's latest mark is not
   evidence of unsent paper. Recovery unfreezes numbering but does **not** reconstruct
   missing payments/stock; reconcile them separately with an accountant. Do not use
   this to bypass an ordinary pending sync.

The browser journey is automated with real Chromium/IndexedDB, not a field pilot.
Device power loss, browser eviction and the actual receipt printer still need a
shop rehearsal. A new page or refresh during a total outage cannot load the app.
