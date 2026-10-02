# 07: The customer portal

**What to build:** A signed-in customer sees their points, their receipts, and can change
their phone.

**Blocked by:** 02, 03, 06. (And ticket 06's renderer, 05.)
**Status:** done

- [x] Extends `/shop/*` (no new Area): points history, the last month's receipts, and a phone
      change that requires the OTP of ticket 03.
- [x] Carries ticket 02's deferred sign-in surface: the `/shop` door offers "continue with
      Google" and counter enrolment side by side, driving `/api/v1/auth/google` and
      `/api/v1/auth/signup`.
- [x] Scoped to the signed-in customer: a second customer cannot read the first's points or
      receipts.
- [x] Empty states are styled, not blank, for a customer who has not bought anything.
- [x] The screen is reachable by `member` under the matrix of ticket 04 and by no other role.
- [x] Tests: the figures match the ledgers; another customer's data is unreachable; the phone
      change goes through the OTP refusal path; a customer with no orders sees the empty state.

## Notes

The consignment view (`.scratch/consignment/issue 09`) hangs off this portal — a consignor
seeing what is owed is the same screen family.

## Continuation checkpoint

**One new page, one public door, one new API — all under `/shop`.**

- **`/shop`** (`src/app/shop/page.tsx`) is the customer's **public** door and the two-door
  screen ticket 02 deferred. `isPublicPath('/shop')` is an *exact* match, not a prefix: the
  door itself has no session to require, while `/shop/products`, `/shop/account` and the rest
  of the area stay guarded. `CustomerSignIn` renders both doors as equal halves — the counter's
  phone-and-password form, and a Google half that is **data, not a dependency: when
  `GOOGLE_CLIENT_ID` is unset the door says so plainly instead of loading Google's script, so a
  shop that never configures Google fetches nothing from Google on its sign-in page. A new
  account collects a phone and an OTP in place and completes through `/api/v1/auth/signup`.
- **`/shop/account`** (`src/app/(shop)/shop/account/page.tsx`) is **member-only**, via a new
  longest-prefix entry `{ prefix: '/shop/account', roles: ['member'] }` above `/shop` in
  `PAGES` (ADR 0022) plus `requireShellUser(['member'])` where the data is sent. The shop nav is
  now filtered by `canReachPage`, exactly as the back-office nav is, so an employee opening the
  shop does not get a menu item that would bounce them. Three panels behind one tab list:
  points, receipts, phone.
- **`src/lib/customer-portal.ts`** is the server read, and its whole security property is that
  every query is scoped by the **session's own id**, never by a value from the request.
  `listCustomerPoints` returns the row's balance (not a sum over the window — a customer with
  more than the hundred rows shown would otherwise see the wrong number) and the newest
  `POINT_HISTORY_LIMIT` (100) ledger entries. `loadCustomerReceipt` reuses `loadReceiptPayload`
  — the one reading the reprint and the walk-in link already share — applies the ADR 0021
  access window, and refuses another customer's order with a **403** rather than a 404: the
  order exists and is simply not theirs.
- **`GET /api/v1/points`** (member-only) and **`GET /api/v1/orders/[id]/receipt`** (now
  branching on role: a member reaches only their own order *with* the window; staff reprint
  anything unwindowed).
- **Receipt download is client-side**: the portal fetches the payload and calls
  `receipt-image.ts`'s `receiptImageDataUrl` in the browser — the same renderer the Chromium
  journey proves — and hands the PNG to a download link. A 410 from the server shows the
  "older than a month" note beside that row while the bill stays listed.

**Tests.** `tests/customer-portal.test.ts` (6) pins the ledger (own entries only, newest first;
the balance read from the row; empty and zero for a customer who never bought) and the receipt
(own order served; another customer's refused 403; past the window refused while the order
survives). `tests/roles.test.ts` gained three: `/shop` public but its siblings not,
`/shop/account` member-only, and the account path denied to employee and admin. `tests/route-audit.test.ts`'s
path count went 18 → 20. Against real HTTP and a database, `scripts/acceptance.ts` section 11b
(5 checks) has the signed-in customer read their own points and receipt, get refused somebody
else's with a 403, and shows staff still reprinting that same order. `scripts/route-audit.ts`
walks `/shop` and `/shop/account` (25 route checks) and its bootstrap now rings up a sale under
the member's number so the portal's ledger is populated rather than empty. Acceptance is **179
checks** (was 174); `npm test` is **1023 tests across 70 files**; `npm run verify:all` passes
all five gates in 4m09s.

**One honesty note.** Two surfaces ticket 06 promised are still absent. The counter has no
"hand this link over" button — the mint route exists, the surface does not — so a walk-in is
*served* a link but not yet *shown* one by a screen. And the `/shop` Google door cannot be
driven end to end here: it needs a real `GOOGLE_CLIENT_ID` and Google's own Identity Services
script in a browser, so the unit suite and the acceptance run exercise the API beneath it and
the rules in `identity.ts`, not the button itself.

Source: ../spec.md, ../../../docs/adr/0020-a-customer-signs-in-with-google.md and
../../../docs/adr/0021-the-electronic-receipt-is-generated.md