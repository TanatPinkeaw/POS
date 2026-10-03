# CONTEXT — the words this system uses

A glossary, not a decision log. **Decisions live in `docs/adr/`** and the state of
the build lives in `README.md`; what this file owns is the vocabulary, because two
of the words below have already been used for two different things in conversation
("คิว" for the pickup code and for the drink number, "void" for a cancelled sale
and for a reversed one) and that is the kind of confusion that ends up in code.

Written in English because the identifiers are English. The Thai in the right-hand
column is what a counter actually sees — the copy a shop reads, not a translation
of the identifier.

## The words a shop says

| Word the shop uses | Thing in the system | Where it lives |
| --- | --- | --- |
| **บิล** | One sale. The row, whatever state it is in. | `orders` |
| **เลขที่ใบเสร็จ** | The **invoice number**: gapless, per year, only for a VAT-registered shop. A document's name, not something anybody shouts. | `orders.receipt_number`, series on `shops` |
| **คิว / เลขคิว** | The **call number**: short, starts at 1 every Bangkok day, on every walk-in bill. Printed on the slip and called out. | `orders.queue_number` + `queue_day` (ADR 0017) |
| **บัตรคิว** | The same number, seen as the paper in the customer's hand. Not a separate object — the slip *is* the ticket. | — |
| **คิวเครื่องดื่ม** | The board of paid tickets whose goods are not handed over yet. | `/pos/queue`, `orders.fulfilment` (ADR 0018) |
| **เสร็จแล้ว / รับแล้ว** | The two taps on that board: the drink is made; the drink has gone. | `fulfilment_state`: `preparing → ready → collected` |
| **พรีออเดอร์** | A customer who orders ahead: stock is reserved at placement and the goods are paid for at handover. Four phases, and the only order type with a PIN. | `orders.order_type = preorder` (SRS §3) |
| **รหัสรับของ / PIN** | The 4-digit code minted when a pre-order is packed, handed over with the goods. | `orders.pickup_pin` (ADR 0006) |
| **ลิ้นชัก / กะ** | The **drawer** is a shift: money that belongs to one person's stretch on the till. Nothing can be sold without one open. | `cash_shifts` |
| **เปิดลิ้นชัก** | Opening that shift with a float. The label is about the drawer because that is what the cashier physically does. | `POST /api/v1/shifts/current` |
| **คืนเงิน** | **Refunding** a bill that was paid: money leaves, and a credit note behind it. | `credit_notes` (ADRs 0004, 0008) |
| **ยกเลิกบิล** | **Voiding** an order that was never paid. No money moved, so no credit note. | `status = cancelled` |
| **ใบลดหนี้** | The **credit note**: the document that reverses a paid sale. Its own gapless series. | `credit_notes.document_number` |
| **ใบกำกับภาษีอย่างย่อ** | The short tax invoice on a VAT-registered sale. The title on the slip. | `orders.is_vat_invoice` |
| **จอลูกค้า** | The **customer display**: a paired screen with no session, told only what a room may see. | `/display`, `display-view.ts` |
| **แต้ม** | Loyalty points. Earned on money collected, never edited by hand. | `point_transactions` |
| **ผู้ฝากขาย** | The **consignor**: a member who leaves goods with the shop to sell for an agreed share. | `products.consignor_user_id` (ADR 0023) |
| **ส่วนแบ่ง** | The consignor's **share** of a consigned sale — a percentage of the net, excluding VAT. | `products.consignor_share_percent` (ADR 0023) |
| **ยอดค้างจ่าย** | The **payable** the shop owes a consignor: accrued by sales, reversed by refunds and payouts. | `consignor_payables` (ADR 0023) |
| **ใบเสร็จอิเล็กทรอนิกส์** | The **electronic receipt**: the slip drawn as an image from the order, offered to the customer for the last month. | generated, not stored (ADR 0021) |

## The words the code uses that a shop does not

- **Ticket** — a call number as the system holds it (`preparing`/`ready`/`collected`).
  Never say "queue" for it in code: `queue_day`/`queue_number` are the number, and
  the pickup code is a different thing that shops also call a queue.
- **Fulfilment** — where the *goods* are, as opposed to where the order's *money*
  is. Two state machines, two columns, deliberately (ADR 0018).
- **Shell** — the authenticated frame (sidebar, account menu) around every screen.
  `ShellUser` is who it was drawn for.
- **Area** — one of the four regions of the app: `admin`, `pos`, `shop`, public.
  `src/proxy.ts` routes between them; `requireRole` in a handler is what authorises.
- **Rule** vs **persistence** — a pure module (`*-rules.ts`, `order-state.ts`,
  `fulfilment-state.ts`, `queue-number.ts`) versus the module that writes rows. The
  split is what lets the money rules be tested without a server.
- **Account** vs **User** vs **Customer** — three different people, and "บัญชี" alone
  says none of them. An **account** is who pays us (the hosted control plane); a
  **user** works in one shop (`users`, any role); a **customer** is a shop's buyer (the
  `member` role). Never write "บัญชี" in code, and in prose name which of the three.
- **Consignor / Consignment / Share / Payable** — the person who leaves goods
  (**consignor**), the arrangement to sell them (**consignment**), their cut
  (**share**), and the debt the shop carries for it (**payable**). The goods are
  *theirs*; the shop sells them as principal (ADR 0023).
- **e-receipt** — the electronic receipt (ADR 0021). Never say "ใบเสร็จดิจิทัล" or
  "soft copy": it is generated from the order, not a stored file.
- **OTP** — the one-time code that proves a phone number. It verifies the **phone**, not
  the person, which is why a phone is the identity and Google is only a door (ADR 0020).

## What this session has settled so far

Recorded here because these are decisions a later reader would otherwise
re-litigate (the reasoning, when it lands, goes into an ADR):

1. **The target is all three kinds of counter shop** — a drink counter, a shop
   selling goods over the counter, and a pre-order-led shop. Not a restaurant with
   tables and a kitchen: `docs/wongnai-pos-gap-analysis.md` §6 item 10 says that is
   a different product, and this decision does not overturn it.
2. **The goal right now is the first shop that sells with it**, not feature
   completeness. So the question every requirement below has to answer is "does
   this stop a shop from trading?", not "is this nice?".
3. **The first shop does not install it — we host it.** So there is no renter to
   hand `docs/renter-onboarding.md` to yet, and "hosted" here means one deployment
   on a box we run. Whether that is one shop or ADR 0016's multi-tenant build is
   **not** settled: nothing about a single shop needs the tenant seam, and the
   release plan is seven phases of work that a first sale does not require.
4. **A network outage must be visible, not silent — and the till keeps selling.**
   Originally the requirement was only that a refusal named itself. Full offline
   selling (a queued local sale that reconciles stock later) was deliberately not
   taken on until a shop lost money to an outage, and then it was: ADR 0019 built
   the queue, number loans and reconciliation, and ADR 0024 closed the cold launch
   so a rebooted till opens with no connection at all. Still refused on purpose:
   PromptPay, member lookup, refunds and any page the device did not prepare.
5. **The call board is always on.** Every walk-in bill mints a number and appears
   on `/pos/queue`; a shop that never calls a number ignores the screen. No
   per-shop switch — a switch is a setting a shop can get wrong on day one, and a
   ticket costs nothing because the board is today and resets at midnight anyway.
6. **Before money changes hands: the restore is rehearsed and the units are loaded
   by a real systemd.** The gaps that stay open are disclosed in writing instead —
   no browser end-to-end test, no experience at real data volume.
7. **The paper and the cash drawer are undecided because there is no hardware.**
   What a shop without a printer gets instead *is* decided (10); a driver talking to
   a thermal printer over ESC/POS is **not** on the table yet.
8. **The first shop's server is a VPS we rent, on a domain we already own at
   Cloudflare**, and HTTPS is not optional from day one (`src/lib/auth.ts:35` sends
   the session cookie `Secure` in production, so a plain-HTTP deployment cannot be
   logged into at all).
9. **Customer data on our hardware requires a written posture first** — a privacy
   notice, a processing agreement with the shop, and a retention and deletion rule —
   before the first real customer's phone number lands there. `users.phone` is
   unique across every role and every sale names a customer, so this is not a
   formality: we hold a shop's customer list.
10. **A shop with no printer still hands the customer its slip**, as a file rather
    than paper. The exact form (a picture the till generates, or a link the customer
    opens) is round 4's decision; what is settled is that "no printer" is a
    supported shop rather than a broken one.
11. **The offline refusal is a runtime check, not a service worker** — a cached app
    shell is a new class of stale-version bug and buys nothing on a tab that is
    open all day.
12. **The till will sell offline and sync later.** Taken on deliberately and
    knowing the price in the table above: five invariants move out of PostgreSQL
    and have to be re-established in the browser. It is **not** a one-session
    change, so it goes through a spec and its own tickets before any code. The
    first shop is served by the hosted deployment while this is built.
13. **A printer-less shop gets its slip as a picture the till draws** — a slip
    drawn with the Canvas API, hand-rolled per the no-dependency rule. The cost is
    accepted on purpose: this is a **second renderer** of the same document and it
    must be kept in step with `Receipt.tsx` by hand, which is the drift the
    repository normally refuses to create.
14. **Goods are sold in whole units.** `order_items.quantity` and
    `products.stock_qty` stay integers: a shop that sells by weight is a different
    product. This closes the question a "shop selling goods over the counter"
    raises, and it is what keeps the oversell guard and the to-the-satang totals
    expressible in integers.

15. **The three edges of 12 are decided** — the specification is
    `docs/offline-till-spec.md`, the decision and its price are ADR 0019:
    * numbers are **lent in blocks** and the series freezes until the device reports
      how far it counted, so the series stays gapless;
    * the stock promise becomes a **safety quantity** the till may not sell through
      (default 0), and a sync that finds the shelf short accepts the bill and lets
      stock go negative with a correction task;
    * **offline reaches a cash sale from a cached catalogue only** — no members, no
      points, no pre-orders, no PromptPay, no refunds, no over-limit discount, and
      the customer display goes quiet.

16. **A customer signs in with Google, but the phone is the identity** (ADR 0020).
    Customers may use Google plus a phone OTP or be enrolled at the counter; the phone
    stays required and unique across every role, and points hang off it. Staff and the
    owner keep the phone-and-temporary-password flow — this amends ADR 0016 §4, which had
    put Google on the owner.
17. **The electronic receipt is generated, not stored** (ADR 0021). A slip drawn from
    the order as an image, offered to the customer for the last month; the order data is
    kept as before, and a walk-in gets it through a signed link.
18. **Page access is a fixed role matrix** (ADR 0022), deny by default, covering the
    three roles as they stand — not a per-shop or per-user setting.
19. **Consigned goods reuse the one money path** (ADR 0023): an owner on `products`, a
    share of the net excluding VAT accrued to a `consignor_payables` ledger, sold as
    principal, never offline in v1, with the shop's accountant still to agree the tax
    treatment.
20. **A receipt link is short-lived and never outlives the month** (ADR 0021 §2–4). The
    download window is a fixed 30 days (`RECEIPT_ACCESS_DAYS`) and is half-open at its
    boundary; an order is never deleted when the window closes. A link is minted per ask
    with its own id and expires at the sooner of an hour (`RECEIPT_LINK_TTL_MINUTES`) and
    the window, so reissue replaces reuse. The shop's own reprint is never windowed — the
    window withholds a customer's download, not the retention.

## Still open (tracked, not decided)

- **The PDPA pack of 9 has no contents yet** — it is decided that it must exist
  before the first real customer's data lands on our hardware, and nobody has
  written it.
- **Whether the first shop's box moves into the shop's own LAN.** Rejected for now
  and recorded as the alternative in ADR 0019; it comes back only if a real shop's
  line proves unreliable enough to lose sales.
- **The printer-less slip** is decided in shape (13) and specified nowhere yet — it
  is its own piece of work, after the offline specification.
- Nothing in this file is a requirement. `system_requirements_document.md` is the
  specification; `README.md` says what is built.
