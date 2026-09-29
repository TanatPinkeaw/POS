# ADR 0011 — The till enrols its own customers

**Status:** accepted (2026-09-29)
**Context:** ADR 0010 made a customer an account that a shop can create, and then
deliberately stopped at the back office: `POST /api/v1/members` was
`requireRole(['admin'])`, and its own decision 5 named the alternative — "letting the
cashier enrol a customer mid-transaction, which is how most Thai shops actually do
it" — as *a different decision with its own questions*. Those questions are what this
ADR answers.

The pressure to answer them is that the counter is where customers actually ask. A
cashier is an `employee`, so `/admin/members` is a screen they cannot open; the
sign-up therefore happened by a manager walking over to the till, or — much more
often — not at all. This supersedes the admin-only half of ADR 0010 decision 5.

## Decisions

### 1. One route, one role wider; editing stays in the back office

`POST /api/v1/members` now takes `['employee', 'admin']`. Not a second
employee-facing route: a separate handler would be a second copy of the same
validation, the same phone normalisation and the same audit action, and the two would
be the same code with one of them a year behind.

Widening it is safe for a reason that is already stated twice in this codebase: the
capability is bounded by the domain function, not by the route's guard.
`createMember` writes `role: 'member'` and never reads a role from the body, and
`requireRole` reads the caller's role from the signed token. So the widest thing a
cashier can mint here is a customer — the same reasoning as ADR 0010 §4, one surface
over.

`PATCH` stays `['admin']`, and that is not symmetry-breaking but the same line drawn
from the other side. Adding a customer is a counter act. Changing how an account
signs in, or closing it, is office work — and a till that could reset a password is a
till that could reset one for an account whose owner is not standing there.

### 2. A dialog over the bill, not a screen

The enrolment is an `Overlay` opened from the bill pane. The basket stays mounted
behind it, which is the whole requirement: a half-rung bill must survive somebody
deciding to join mid-transaction, and that is exactly when they decide. Navigating to
a different screen is how a till loses a cart.

It is also why the dialog exists at all rather than a link to the back office. And it
is what makes the second half of the flow possible: on success the new customer is
attached to the *current* bill. A cashier enrols somebody and keeps selling, in one
motion, without retyping the number they searched for.

### 3. Two fields, and the number arrives pre-filled

Name, phone, temporary password. There is no email field at the counter: it is the
one detail a customer in front of a cashier may not be able to dictate, and a manager
can add it later from `/admin/members`.

The phone number is seeded from the till's search box. That is not merely
convenience: the only path to this dialog is searching a number and finding nobody,
so the number is already typed — and pre-filling it is what guarantees the fresh
account is created under the number that was actually searched, rather than under a
second one typed from memory with a queue waiting.

### 4. The same temporary password

The credential is unchanged from ADR 0010 §2: a password the cashier says out loud,
temporary in intent, changed by the customer from their own screen afterwards. A
cashier already counts the drawer and sees the day's takings, so handing out a
temporary password is not a new class of trust — and what the credential unlocks is a
pre-order, not cash. The eight-character rule is checked in the dialog as well as on
the server, because a form that submits and then reports "too short" makes the
operator read the same sentence twice.

### 5. The duplicate refusal is now Thai

This fell out of the change and belongs in the record, because the check moved from
"only a manager ever sees it" to "every cashier meets it": the same phone number
handed to two customers is the one failure this flow actually produces at a counter,
and it was an English string — `An account already exists for …` — in three copies
(`members.ts`, `staff.ts`, `setup.ts`). A user-visible refusal is Thai by rule, so
all three now say the same Thai sentence.

### 6. The door is counted, unlike the till's other writes

Enrolling is the first *signed-in* door with a rate limit on it, which ADR 0009
decision 3 said the till would not have. That decision still holds for selling — a
cashier who can outrun the API has a performance problem, not a security one — and
the line between the two is not "authenticated or not" but **what the call makes**: a
sale is revenue the shop wants, while this is a credential that can reserve stock
without paying for it, plus a bcrypt hash of CPU to produce it.

The policy is `member_create` — ten back to back, then one a minute, refilled
continuously like every other bucket, so a queue keeps moving all day and the ceiling
is only ever met by something that is not typing. It is keyed by the **signed-in
account**, not the address: two cashiers on the shop's one wifi are two people, and
neither should be able to spend the other's budget, while signing out and back in does
not mint a fresh one because the budget belongs to the account.

Nothing new was needed for the refusal to reach a person: the dialog prints the
server's own Thai sentence, "พยายามหลายครั้งเกินไป — กรุณารออีก …", which every other
rate-limited door already produces.

## Consequences

- A cashier can serve the whole of the shop's product where they stand: enrol a
  customer, sell to them, attach the points. The acceptance journey's section 11 now
  enrols its second customer as the cashier, and then signs in as that account to
  prove it is a member rather than staff.
- The limiter's policy table gains a seventh entry, and it is the only one keyed by
the signed-in account rather than by the address — see decision 6.
- The 403 the journey used to assert did not vanish; it moved one method over, to
  `PATCH /api/v1/members/{id}`.
- No route was added, so `route:audit` still walks seventeen screens and the till's
  read-only `GET /api/v1/members` lookup is untouched.
- The acceptance run is 140 checks rather than 133.

## Known gaps, stated rather than discovered

- ~~**Nothing rate-limits enrolment.**~~ Closed by decision 6: ten in a burst, then
  one a minute, per signed-in account. What is *not* capped is every other
  authenticated write — a sale, a refund, a stock adjustment. That remains ADR 0009's
  position, and it is still right: those are revenue and the work the shop is paying
  for, not credentials.
- **The customer leaves the counter with nothing on paper.** The password is spoken;
  there is no card, no receipt and no printed slip, so a customer who forgets it
  before changing it telephones the shop.
- **A typo in the name cannot be fixed by the customer.** Correcting it is
  `/admin/members`, and by ADR 0010 §1 a rename is not audited — which is still the
  right call, but it does mean the cheapest fix is a manager's time.
- Still no points adjustment, no deletion and no self-service password reset; those
  remain ADR 0010's gaps and nothing here changes them.
