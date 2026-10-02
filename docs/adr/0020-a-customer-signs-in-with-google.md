# ADR 0020 — A customer signs in with Google, and the phone stays the identity

**Status:** accepted (2026-10-02). **Amends ADR 0016 §4**, which made Google the *owner's*
door and left the counter on phone and password; this decision keeps the counter on phone
and password and moves Google to the **customer**.

**Context.** A shop's customer (a `member`) is enrolled today at the counter: a phone
number and a temporary password the cashier reads out (ADRs 0010, 0011), because a shop has
no email on file and the customer has no app. That flow works and cannot be removed — a
walk-in has no Gmail. But a customer who *does* want an account has no way to sign in except
the temporary password, and the ask is that they sign in with **Google**, proving their
phone with an **OTP**, while their **points keep working** and the shop's staff and owner
keep the password flow they already have.

Three facts shape this, and each is load-bearing:

- **`users.phone` is unique across every role**, and every sale, pre-order and point ledger
  entry names a customer by it. The phone is the identity, not the login.
- **Points live in a ledger keyed to the customer row** (`point_transactions`). A second row
  for the same person splits the balance, which is the one outcome this decision must not
  produce.
- **Google is not universal.** ADR 0016 was right that a cashier at 7am may have no Gmail;
  the same is true of a customer at the counter. So Google is an *additional door*, never the
  only one.

## Decisions

### 1. Google is the customer's door; phone and password remain the shop's door

A `member` may sign in with Google. An `employee` or `admin` may not: they keep the phone
number and temporary password the shop enrolled them with (ADR 0011), which is the flow a
counter actually runs. This is the opposite of ADR 0016 §4's assignment, and it is the point
of this ADR — the question "who has a Gmail account?" has *customer* as its answer, not
*owner*.

### 2. The phone stays required, unique, and the identity

Every customer has a phone number, it is unique across every role (unchanged), and the
points, pre-orders, prize-of-collection code and messages all hang off it. **Google is a way
to sign in; the phone is who you are.** A customer cannot exist without a phone, even one
who registered with Google.

### 3. Two doors to becoming a customer, neither required for the other

- **Self-signup:** continue with Google, then give a phone number and confirm it by OTP.
- **Counter enrolment:** the existing flow (ADR 0011) — a name, a phone, a temporary
  password — unchanged.

A shop that only ever enrols at the counter is a supported shop. So is one whose customers
only ever self-serve. Requiring Google would drop the walk-in; requiring the counter would
drop the customer who found the shop online.

### 4. A returning member is *linked*, never duplicated

When somebody signs in with Google for the first time and gives a phone number that already
belongs to a `member`, the Google credential is **attached to that existing row** — after the
OTP has proved possession of the number — rather than a second customer being created.
Splitting the row would split the points, which is the failure §"The phone is the identity"
exists to prevent. Refusing the sign-in would be worse: a customer whose number is already
registered could never use the Google door.

### 5. OTP is verified once, and on every phone change

The phone is confirmed by OTP **at signup** and **every time it changes**. It is *not*
required on every sign-in — a customer standing at the counter should not be reading an SMS
to check their own points. Changing a number is the higher-risk act (it moves the identity
and can capture a balance), so it always re-proves the new number.

### 6. The Google token is verified here, against JWKS

The id token is verified in-process with `jose` against Google's JWKS (RS256). The
alternative — Google's `tokeninfo` endpoint — is defensible but couples every sign-in to a
network round trip and to Google's rate limits for no crypto we do not already have; `jose`
is a dependency of this repository already (the session token and the pickup code use it).

### 7. The owner signs up with Google, then sets a phone and password

The shop's *owner* — the account that pays us, created during hosted signup — continues with
Google. Once inside, they set a phone number and password for daily use, so the counter is
never blocked on a Google session. Staff are unchanged (phone and temporary password).

### 8. One `users` table, one identity per phone

There is no separate `customers` table. A phone number belongs to exactly one identity, and
a `member` cannot also be an `employee` under the same number: a staff account that wants
member benefits uses its staff standing (or a second number), not a second identity. This
keeps the cross-role uniqueness that makes sign-in unambiguous.

## Consequences

- **A new unauthenticated door that costs money.** Sending an OTP is reachable without a
  session and spends real money (SMS) per attempt, so it goes through the shared limiter
  (ADRs 0009, 0012), counted per number *and* per address — one of the two things a caller
  can otherwise make the shop pay for.
- **A customer portal.** `member` gains a place to see points history, change a phone (with
  OTP) and download receipts (ADR 0021); it extends `/shop/*` rather than opening a new Area.
- **PDPA grows.** A customer's phone was already on our hardware; a Google identity is one
  more piece of personal data, and the privacy posture is still unwritten (CONTEXT item 9).
- **The SMS provider is a seam, not a commitment.** One interface, one implementation chosen
  at deploy time through `.env`, exactly as `NOTIFY_CHANNEL` is.

## Built, and the gaps left

- **The credential half is built.** `src/lib/google-id-token.ts` verifies an id token in
  process against Google's JWKS — RS256, this deployment's client id, Google's own issuer —
  and `users.google_subject` is nullable and unique, so a Google account belongs to exactly
  one customer. A token minted for another app, expired, or signed with another key is
  refused; a symmetric token offered where an RSA one was expected is refused too.
- **The phone half is built.** `otp.ts` is the provider seam (`OTP_CHANNEL=webhook` plus a URL
  and an optional secret, the shape `NOTIFY_CHANNEL` already has) and `otp-store.ts` keeps one
  hashed, expiring, attempt-limited challenge per phone. The send door is unauthenticated and
  rate-limited per number *and* per address (`otp_send_number`, `otp_send_address`).
- **A phone change is built.** `changeCustomerPhone` proves the new number by consuming *its*
  OTP before anything is written, refuses a number another identity already holds (the unique
  index as the backstop under the read), and audits the move with the number it came from;
  `PATCH /api/v1/auth/phone` reaches it — session-authenticated, a customer only — and
  re-issues the session so the token's phone claim agrees with the row at once. A code issued
  for the old number cannot move the identity: the challenge is looked up by the number being
  moved *to*.
- **OTP-once means a number can be captured.** If a phone is later reassigned and its new
  owner signs in, nothing re-proves that they are not the original customer. Step-up on the
  remaining sensitive action (redeeming points) is the mitigation still to build; step-up on
  every sign-in is deliberately not. Changing a number is no longer on that list — it always
  re-proves the new one.
- **Signup and linking are built.** `src/lib/identity.ts` is the whole rule, and its order is
  the decision: a Google subject already on a row signs in (no code); otherwise the phone is
  proved by consuming the OTP; then whoever owns the number decides the rest — a staff number
  is refused, a member's row gets the subject *attached* (one row, points and history intact,
  and never renamed), and a number nobody owns makes a customer with a random password hash.
  `POST /api/v1/auth/google` answers `needsPhone` for an unknown account and signs a known one
  in; `POST /api/v1/auth/signup` finishes the first sign-in. A second Google account cannot
  take a number another holds, and the unique index is the backstop under the two reads a race
  could slip between.
- **The `/shop` screen is not built.** The doors exist as API calls only; the sign-in surface
  that offers "continue with Google" and the counter side by side (and the two-door ticket 02
  asks for) arrives with the customer portal (ticket 07). Until then the counter flow
  (ADR 0011) and the API are how a customer exists.
- **No provider is chosen**, and no OTP budget is set: the seam is here, the shop points it
  at a gateway at deploy, and `GOOGLE_CLIENT_ID` must be set for the Google door to accept
  anything.
