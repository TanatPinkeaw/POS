# ADR 0010 — Customers are accounts, created at the counter

**Status:** accepted (2026-09-28)
**Context:** The SRS assumes members exist. `POST /api/v1/orders` refuses a
pre-order without a `customer_id`, `requireRole(['member'])` gates the whole `/shop`
area, and SRS §5 loyalty is meaningless without a customer — but nothing in the
system created one. The seed file could, and the acceptance journey inserted one with
SQL, which is a fair summary of the gap: a freshly installed shop had no way to reach
half of its own product, and the only workaround was a developer.

Found while building the pickup code (ADR 0006), and it had been the head of the open
threads in `AGENTS.md` ever since, for the plainest reason available: everything
customer-facing was behind it.

## Decisions

### 1. A member is a credential, and the screen says so

A customer account is not an address-book entry. It can sign in, it can place a
pre-order, and **a pre-order reserves stock without paying for it** — which is the
one capability in this system worth inventing an identity to obtain. A shop with no
inventory of who its customers are cannot tell a regular from a stranger opening
twelve pre-orders on a phone they will never answer.

So creating one is treated as what it is: `member_created` is written to the audit
trail, naming the manager who did it, and editing one is audited when the edit
changes *how that account signs in* — the phone number, the email (both are login
identifiers), the password, or whether the account is open at all. A rename is not
audited, and that line is drawn deliberately: the value of a trail is in being
narrow, and a corrected spelling is not an event.

### 2. The password is temporary, and typed in front of the customer

No self-sign-up, no SMS invitation, no "we'll email them a link". A shop with a
customer standing at the counter has no email address on file and no app installed
on the customer's phone, so the only flow that works is the one a shop already uses:
the cashier (or here, the manager) types a password and says it out loud. It is
temporary in intent — the customer changes it from their own screen once signed in.

The rule about what a password may be moved to `password.ts` because of this: three
surfaces now hand out a temporary credential (the wizard, the staff screen, this
one), and a length stated in three places is three different numbers within a year.

### 3. Uniqueness spans every role, and survives the punctuation

`users.phone` is unique across admins, employees and members. That is not obvious
and it is load-bearing: a cashier's number reused by a customer account would leave
the cashier unable to sign in, and no error message would explain why. So
`080-000-0002` and `0800000002` normalise to one value (shared with the staff
surface through `phone.ts`) and the collision is refused with a 409 whichever role
owns the number — the message deliberately does not say which.

### 4. This screen cannot touch a staff account, and vice versa

`updateStaff` already refused members. The reverse refusal (`updateMember` refuses
anything that is not a member) is what keeps this surface from being a way to rename
a cashier or reset their password, and it is the same shape: role is a property of
the *surface you are standing on*, never of a request body.

### 5. Admin-only, and the till stays read-only

Enrolling a customer is reached from the back office (`/admin/members`), and the API
is `requireRole(['admin'])` — matching the layout gate, so there is no capability an
employee holds and cannot reach. The till's existing `GET /api/v1/members` lookup is
untouched: a cashier attaches a customer to a sale and reads their points, and that
is all a cashier needs.

The honest alternative — letting the cashier enrol a customer mid-transaction, which
is how most Thai shops actually do it — is a *different* decision with its own
questions (does it interrupt the basket? who types the password?), and it belongs on
the POS screen rather than smuggled in here.

### 6. Points are shown and never edited

The screen displays the balance and the order count, and there is no field to change
either. A points balance is the sum of a ledger with its own rules, and a screen that
could type a number into it would be a screen that can invent a liability without a
reason attached. Adjusting points is the loyalty module's decision to expose later,
with its own audit action.

## Consequences

- A fresh shop can now serve a customer end to end: enrol them, take a pre-order,
  hand it over, and see the points land. The acceptance journey's last SQL fixture is
  gone — the manager creates the customer over HTTP, and the whole pre-order and
  pickup leg now runs against a server somebody else started (`--base-url`), which it
  could not before.
- `route:audit` walks seventeen screens instead of sixteen, and it too enrols its
  customer through the API rather than writing a row.
- Two more audit actions (`member_created`, `member_updated`), so the trail screen's
  labels, tones and target descriptions were extended with them.
- The customer list is loaded whole and filtered in the browser. Correct for a shop's
  customers; a deployment with tens of thousands would need paging, and the till's
  phone lookup already covers the case where the list is useless.

## Known gaps, stated rather than discovered

- **A cashier cannot enrol a customer at the till.** Decision 5.
- **No self-service sign-up, and no password reset by the customer.** A customer who
  forgets their password telephones the shop, and a manager sets a new temporary one.
  The obvious improvement is letting a member change their own password from `/shop/*`,
  which is a screen rather than a policy.
- **No deletion, only deactivation.** A closed account keeps its orders, points and
  pre-orders, because those are the shop's records rather than the customer's — an
  erasure request is a data-protection decision, not a `DELETE`.
- **No points adjustment, and no membership tier or discount.** Decision 6.
