# ADR 0006 — The pickup QR is a signed code, and the PIN stays

**Status:** accepted (2026-09-28)
**Context:** SRS §3 asks for a PIN *and* a QR at collection, and only the PIN was
built. `qrcode` had been a dependency since the PromptPay panel and was unused.
Adding the missing half raised the question the PIN had been quietly answering on
its own: what is a handover credential, and what should the second one be?

## Decisions

### 1. The code is minted, not stored

`src/lib/pickup-token.ts` signs a JWT whose subject is the order id and whose `exp`
is the order's own `pickup_expires_at`. Nothing about it lives in a column: it is
derivable from a row the shop already has, so there is no second thing to keep in
step and no long-lived secret sitting in the database.

Rejected: a random `pickup_code` column. It would have meant a migration, a
backfill for every order already waiting, and a stored value that is a bearer
credential for somebody's shopping — the kind of column that leaks in a backup and
has to be rotated by hand.

### 2. It expires exactly when the hold does

The token carries the hold's deadline rather than a lifetime of its own. A QR
screenshotted on Monday is worthless on Wednesday, and there is no second clock
that can disagree with the sweeper that expires the reservation.

A token that verifies but names an order that is no longer waiting is *not* refused
by the signature — the lookup refuses it, because "is this parcel on the shelf" is
a fact about the order, not about the code. `findOrderForHandover` therefore takes
either credential down the same `ready_for_pickup` filter, so a code for a
collected order finds nothing, exactly as its PIN would.

### 3. It is not a session, and that is asserted rather than assumed

The token has its own issuer and audience. A signed-in member presenting their
session cookie as a pickup code must not collect a parcel, and the test suite makes
that failure explicit rather than inferring it from a shared signing key.

### 4. The PIN stays, next to the QR

They fail differently: the QR is faster and cannot be mistyped, the PIN survives a
flat battery, a cracked screen and a customer reading it down the phone. A shop
that offers only one of them strands somebody eventually, so the customer's order
screen shows both.

This is also why the till's lookup box was never split into two fields. The counter
has one box that a scanner types into, so the *shape* of what arrived decides where
it goes, and that rule lives in a pure module (`src/lib/pickup-scan.ts`) instead of
inside a ternary in a screen. It is a shape test and not a verification:
deciding what a term is by trying to verify it would make a mistyped phone number
come back as "that code is not valid", which sends a cashier looking in the wrong
place.

### 5. A bad code is a 422 domain error, not a 500

`InvalidPickupTokenError` extends `DomainError`. It started as a plain `Error`,
which `withApi` flattens to a 500 — so an expired or mistyped code reached the
cashier as "something went wrong on our side". Nothing on our side had gone wrong;
the QR was stale. The distinction is worth stating because it is invisible in
review: both versions type-check and both versions refuse the request.

### 6. The public collection board carries neither credential

The queue-facing display lists order number, an initial and a ready time. It is
rebuilt from `listOrderViews`, which *does* carry the PIN and the code — so the
projection is the safety boundary, and it is pinned by a test over the serialised
payload rather than field by field. `pickupToken` was one line away from being
spread wholesale into that payload.

## Consequences

- Collection no longer depends on a customer being able to read four digits aloud.
- No new table, no new column, no backfill; the only schema-adjacent cost is that
  `OrderListView` now signs up to one token per order that is actually waiting.
- The signing key is the same secret as sessions (`authSecretKey()`), which is
  acceptable precisely because the audience separates them — but it means rotating
  that secret logs out staff *and* invalidates codes on the shelf. A shop that
  rotates it mid-day should reprint any codes already handed out.
- Anything that reads orders now has a new field to think about. The list is the
  only shape that carries it, and the display projection is the one place that
  must keep dropping it.

## Revisit when

- A shop wants to collect a parcel with neither the customer nor their phone
  present (a courier, a friend). That is a different question — identity rather
  than a bearer code — and the honest answer today is the PIN plus a phone call.
- Notification delivery lands (the outbox in `docs/wongnai-pos-gap-analysis.md`
  §4.2). A code that is *pushed* to the customer is worth having; a code that is
  emailed is a code in a plaintext archive, and that trade-off has not been made.
- Members can be created at all. Today nothing in the API can create one (gap
  analysis §4.3a), so there is no self-service screen to put a QR on.
