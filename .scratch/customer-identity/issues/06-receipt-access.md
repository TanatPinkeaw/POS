# 06: Getting the receipt — a portal download and a signed link

**What to build:** A customer downloads the last month's receipts; a walk-in with no account
gets one through a signed link.

**Blocked by:** 05.
**Status:** done

- [x] A signed link that names exactly one order and expires — the shape of
      `pickup-token.ts`, with its own audience so another session cannot present it.
- [x] The **last month** is the access window: an older bill offers no file while its order
      stays visible. Nothing is ever deleted.
- [x] The link can be handed over at the counter for a customer who never registered.
- [x] Reissue rather than reuse: a spent or expired link does not silently keep working.
- [x] Tests: a link serves exactly its order and expires; a bill older than a month offers no
      file but still lists; a link for another order is refused; the order data is untouched by
      any download.

## Continuation checkpoint

**Two pure modules, one HTTP path.**

- `src/lib/receipt-access.ts` — the window. `receiptWithinAccessWindow(soldAt, now, days)`,
  `receiptAccessUntil`, and `receiptAccessDays()` reading `RECEIPT_ACCESS_DAYS` (default 30).
  "The last month" is a fixed count of days, not a calendar month: a calendar month has no
  single length, so its end is not a single testable instant. The window is half-open — closed
  exactly at its boundary — and it is an *access* rule: the order is never touched.
- `src/lib/receipt-link.ts` — the link, the shape of `pickup-token.ts` with its own audience
  (`receipt-download`) and scope (`receipt`), so neither a session nor a pickup code can be
  presented as a receipt link (asserted, not assumed). Two clocks bound it: its own short life
  and the window, and the expiry is the **earlier** of them, so a link can never outlive the
  month it was granted under. `InvalidReceiptLinkError` is a 422; `ReceiptWindowClosedError` is
  a distinct 410, because "this link is broken" and "this bill is more than a month old" are
  different things to tell a person.
- `src/lib/order-view.ts` gained `loadReceiptPayload(orderId)`, the one reading of the order
  that both the DOM reprint route and the customer's downloaded image now share — so a screen
  and a picture cannot disagree over a field. `GET /api/v1/orders/[id]/receipt` was reduced to
  that call, unchanged in behaviour.
- `POST /api/v1/orders/[id]/receipt-link` (employee/admin) mints a **fresh** link per call and
  returns its path. `GET /api/v1/receipts/[token]` is **session-free** — the link is the
  credential, the door a walk-in uses — and enforces the window per read, so a link minted on
  the last day is still refused once the window closes under it. The shop's own reprint stays
  unwindowed: the month withholds the customer's download, not the retention.

**Reissue, not reuse** is a `jti`: two links for one order are never the same string, so one
leaked link never becomes the order's permanent key.

**Tests.** `tests/receipt-access.test.ts` (8) pins the boundary — a day inside, a millisecond
inside, exactly at it, a month and a day out — and the configured day count.
`tests/receipt-link.test.ts` (14) covers naming one order, expiry, a flipped signature, a
swapped subject, and refusal of a session token *and* a pickup code; the stream of junk; the
422/`INVALID_RECEIPT_LINK` shape; a fresh token per issue; and the expiry cap. Against real
HTTP and a real database, `scripts/acceptance.ts` now (11 checks) mints a link as the cashier,
fetches it as a **session-less stranger** and gets exactly that order, refuses a one-character
change (422), reissues a different token, proves a download leaves a whole-row `md5` of the
order untouched, ages the sale 40 days to show the link (410) and the mint (410) refused while
the bill still lists and reprints and the order stays visible, then restores it and shows the
file offered again. Acceptance is 151 checks (was 140); `npm test` is 959 tests across 64
files.

**One honesty note.** The link and the window are built and exercised, but there is **no
customer-facing screen** yet: `GET /api/v1/receipts/[token]` returns the same `{ shop, receipt }`
the reprint route does, and the client that draws it with `receipt-image.ts` is the portal
(ticket 07). The counter has the mint route but no "hand this over" surface of its own. So a
walk-in can be *served* a link today, but not yet *shown* one by a screen.

Source: ../spec.md and ../../../docs/adr/0021-the-electronic-receipt-is-generated.md.
