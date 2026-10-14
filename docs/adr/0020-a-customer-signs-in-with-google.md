# ADR 0020 — A customer signs in with Google, and the phone stays the identity

**Status:** accepted (2026-10-02). **Amends ADR 0016 §4**, which made Google the *owner's*
door and left the counter on phone and password; this decision keeps the counter on phone
and password and moves Google to the **customer**.

**§1 amended (2026-10-12):** the button now asks a phone for Google's `redirect` UX mode and
a desktop for `popup`, the credential comes back as a form POST to an endpoint of this
deployment's own, and a first sign-in is finished from a short-lived handoff instead of from
a token the browser holds. The amendment is written out below §1, and `docs/renter-onboarding.md`
now names the redirect URI the operator has to register.

**Context.** A shop's customer (a `member`) is enrolled today at the counter: a phone
number and a temporary password the cashier reads out (ADRs 0010, 0011), because a shop has
no email on file and the customer has no app. That flow works and cannot be removed — a
walk-in has no Gmail. But a customer who *does* want an account has no way to sign in except
the temporary password, and the ask is that they sign in with **Google** and give a phone
number, while their **points keep working** and the shop's staff and owner keep the password
flow they already have.

**Amended while building:** the ask named a one-time code on that number. It is dropped —
§5 records why, and what the proof moved to instead.

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

**Amended — the button asks a phone for a different shape than a desktop.** That door was
built on one call, `google.accounts.id.initialize({ client_id })`, with no `ux_mode`,
which is Google's default `popup`: the credential comes back to the page through a
cross-origin `postMessage`. Google's supported-browsers page carries the footnote **"Due to
ITP redirect mode is required for iOS"**
(https://developers.google.com/identity/gsi/web/guides/supported-browsers), and on iOS
every browser is WebKit with Safari's Intelligent Tracking Prevention in front of the
handshake — the same fact ADR 0031 records from the build side, where it means there is no
other browser for the customer to switch to. So the shop's own customers, the ones holding
iPhones, were on the one mode Google documents as not for iOS.

`google-door.ts` decides which mode a device is asked for, as a pure function: any
`iPad`/`iPhone`/`iPod` token gets `redirect`, and so does an iPad in desktop mode — Safari
on an iPad reports `MacIntel` and is only distinguishable by having more than one touch
point. Everything else keeps Google's default. Missing signals read as *not* iOS, because a
wrong answer in that direction is the behaviour the deployment already had and a wrong
answer the other way sends a desktop through a mode it does not need. A deployment that
cannot name its own public address (`publicBaseUrlOr`) falls back to popup rather than
sending a phone to a POST nobody answers — a degraded door, not a broken one.

**Redirect mode's cost is paid deliberately: the browser never sees the credential.**
Google POSTs `credential` and `g_csrf_token` to `login_uri`, and the integration guide is
explicit that a JavaScript callback is impossible because "users have already been
redirected away from your web page"
(https://developers.google.com/identity/gsi/web/guides/integrate). A page route cannot
receive a POST here, so the address is an endpoint — `POST /api/v1/auth/google/redirect` —
and `login_uri` is one literal built in one place (`googleRedirectLoginUri`), because the
button, the route and the operator's console registration all have to name the same string
as a string. The route checks that the body is the form Google sends, compares
`g_csrf_token` with the cookie of that name (Google's own documented double submit),
verifies the id token against Google's JWKS exactly as the popup path does, plans the
arrival with `planGoogleArrival`, and answers **303** — 307 preserves the method, which
would re-POST the form to a page route that cannot take it.

The one deliberate softness: when the CSRF *cookie* is absent the route logs an English
line and proceeds. Whether a browser attaches a cookie set for this origin to a cross-site
top-level POST is not something this deployment controls, and refusing on it would invent a
new phone-only failure in the middle of a change whose purpose is to remove one. What stays
unproven is a login-CSRF, not the identity: the id token still has to verify for our client
id, and the log line is what makes that a diagnosis rather than a guess.

**A first sign-in needs a second handoff.** The popup road posts the id token again with the
phone; the redirect road has no token in the browser at all. So the landing leaves a
ten-minute httpOnly `pos_google_pending` cookie (`google-pending.ts`) naming the Google
subject it just verified, and `POST /api/v1/auth/signup` accepts either proof — an id token
when the caller has one, that handoff otherwise. The handoff is the same shape
`line-pending.ts` is, for the same reasons, down to its own JWT audience alongside the
session's, the pickup code's and the receipt link's. It is spent on success (a second POST
cannot re-attach the same Google account to a different number) and left alone on failure (a
refused number is worth retrying on the same screen). One rule still decides who may become
a customer — `identity.ts`, unchanged — and both roads end in one `GoogleIdentity`.

*The alternative rejected: redirect for every device.* It is one path instead of two, and
Google recommends it for new integrations — but the requirement Google states is *for iOS*,
popup is the shape it calls often preferred on a desktop, and a shop whose OAuth client has
not registered the login URI yet would then lose Google on every device at once instead of
on the phones only. Switching the whole deployment over is one line in `googleUxModeFor`
when that trade looks better.

### 2. The phone stays required, unique, and the identity

Every customer has a phone number, it is unique across every role (unchanged), and the
points, pre-orders, prize-of-collection code and messages all hang off it. **Google is a way
to sign in; the phone is who you are.** A customer cannot exist without a phone, even one
who registered with Google.

### 3. Two doors to becoming a customer, neither required for the other

- **Self-signup:** continue with Google, then give a phone number. No code is sent: Google
  proves the Google account, and the number is only where the new customer's points and orders
  will hang.
- **Counter enrolment:** the existing flow (ADR 0011) — a name, a phone, a temporary
  password — unchanged.

A shop that only ever enrols at the counter is a supported shop. So is one whose customers
only ever self-serve. Requiring Google would drop the walk-in; requiring the counter would
drop the customer who found the shop online.

### 4. A number somebody already holds is refused, never linked

When somebody signs in with Google for the first time and gives a phone number that already
belongs to a customer, the sign-in is **refused**; the Google credential is *not* attached to
that row. Nothing in this door proves the number — Google proves the **Google account** and
says nothing about the digits typed beside it — so attaching on the strength of a typed number
would hand anybody who can type it the points and the order history hanging off that row. The
owner reaches that row with the password the counter handed over when it enrolled them
(ADR 0011), which is a credential this door neither needs nor weakens. Refusing costs the
returning customer nothing they had; linking would cost the person whose row was taken
everything in it.

### 5. The phone is proved on a change, not at signup

OTP at signup is dropped — the change from the original ask. Proving a number by a code before
writing it is real assurance, but it does not stop the takeover §4 describes: a code sent to a
phone reaches whoever is holding that phone, and the failure modes — a reassigned number, a
shared handset — are what make the proof worth less than it looks. So the proof moves to the
one act that genuinely moves the identity: a phone **change** always re-proves the number being
moved *to*, because it can capture a balance. A first sign-in neither proves nor needs a code —
it either finds the number free (and makes a customer) or finds it taken (and refuses) — and a
signed-in customer never re-reads a code to check their own points.

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

- **The one unauthenticated door that costs money is now the phone change.** An OTP send is
  reachable without a session and spends real money (SMS) per attempt, so it goes through the
  shared limiter (ADRs 0009, 0012), counted per number *and* per address — one of the two
  things a caller can otherwise make the shop pay for. Signup no longer reaches it.
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
- **The phone half is built, and now serves only a change.** `otp.ts` is the provider seam
  (`OTP_CHANNEL=webhook` plus a URL and an optional secret, the shape `NOTIFY_CHANNEL` already
  has) and `otp-store.ts` keeps one hashed, expiring, attempt-limited challenge per phone. The
  send door is unauthenticated and rate-limited per number *and* per address
  (`otp_send_number`, `otp_send_address`); a phone change reaches it, signup does not.
- **A phone change is built.** `changeCustomerPhone` proves the new number by consuming *its*
  OTP before anything is written, refuses a number another identity already holds (the unique
  index as the backstop under the read), and audits the move with the number it came from;
  `PATCH /api/v1/auth/phone` reaches it — session-authenticated, a customer only — and
  re-issues the session so the token's phone claim agrees with the row at once. A code issued
  for the old number cannot move the identity: the challenge is looked up by the number being
  moved *to*.
- **A number is never re-proved at sign-in, so a reassigned one can be captured.** If a phone
  is later reassigned, its new holder reaches the row by signing in with the password they
  inherited, and nothing re-proves they are the original customer. Step-up on the remaining
  sensitive action (redeeming points) is the mitigation still to build; step-up on a sign-in
  is deliberately not. A phone change is not on that list — it always re-proves the new one.
- **Signup is built, and it refuses rather than links.** `src/lib/identity.ts` is the whole
  rule, and its order is the decision: a Google subject already on a row signs in; otherwise the
  number decides — one nobody owns makes a customer with a random password hash, a staff number
  is refused (`PHONE_BELONGS_TO_STAFF`), and a number a customer already holds is refused too
  (`PHONE_ALREADY_REGISTERED`) rather than attached. `POST /api/v1/auth/google` answers
  `needsPhone` for an unknown account and signs a known one in; `POST /api/v1/auth/signup`
  finishes the first sign-in. Two Google accounts cannot share a number, and the unique index is
  the backstop under the reads a race could slip between.
- **The device split, its endpoint, and its handoff are built (2026-10-12).**
  `google-door.ts` is the pure decision (which mode, which `login_uri`, what an arrival
  earns, which Thai words the front door shows for `?google=`), and `google-pending.ts` is
  the ten-minute handoff; `POST /api/v1/auth/google/redirect` carries the form POST and
  `POST /api/v1/auth/signup` finishes a first sign-in from either proof. The landing is
  rate-limited per address (`google_redirect`, ADR 0009) because the work behind it is a
  JWKS fetch and, on the successful path, a minted session. Every refusal logs the stage it
died at (`body`, `no-credential`, `csrf-missing`, `csrf-mismatch`, `no-client-id`,
  `credential`), because the failure it replaces is invisible on a desktop: "the Google
  button does nothing on my phone" has no other evidence, and those stage names are
  different diagnoses. **`npm run google:door`** drives all of it in actual WebKit under
  Playwright's iPhone profile — what the page hands Google, a real cross-origin form POST
  landing on the route, and the customer opening `/shop/products` afterwards. What that
  does *not* prove: WebKit is not iOS, the profile is a user agent and a viewport rather
  than Safari 15.6, and no Google server is contacted — the runner's stub answers in
  Google's place, so what is proven is the configuration this deployment sends and the
  landing it serves.
- **The registration is measured now, not only documented (2026-10-12).** The device split
  above put the door's fate in an OAuth client's *Authorized redirect URIs* — a list that
  lives in someone else's console, and whose one failure mode is invisible here: a customer
  on a phone gets Google's `redirect_uri_mismatch` page, Google refuses before it sends them
  anywhere, and the shop's own log has nothing in it at all. That is not hypothetical — it
  is what the first customer met, and the only evidence in the world was their screenshot,
  while the code on the deployment was already correct. So the question is asked rather than
  assumed: `google-registration.ts` is the pure half (the request that puts the same
  `redirect_uri` to Google's authorize endpoint, and the reading of its answer) and
  **`npm run google:check`** is the I/O half, which also compares the configured address
  against the one the *running* process serves and posts an empty credential to the landing
  to prove it answers 303. Measured against the shop's own client, the two mistakes read
  differently on this side as well: an address never registered answers
  `redirect_uri_mismatch`, a host Google refuses outright answers `invalid_request`. What it
  does **not** prove: an OAuth client's URI list is not readable by any API, so "registered"
  is the *absence* of an error page, and that branch is argued from Google's own ordering
  rather than measured here — no client in this checkout has a registered URI to point at.
  The *origin* entry is outside it entirely; a missing one paints no button, which
  `CustomerSignIn` already says on the screen. Registered-then-forgotten is the other
  limit: a shop that changes `PUBLIC_BASE_URL` to a new address breaks the door until the
  console gains it too, and only the next run of the check says so.
- **The two doors, and the portal, are built.** `/shop` (public, ticket 07) offers continue
  with Google and the counter's phone-and-password  side by side; a Google sign-in that is a new
  account collects a phone in place, and one that is already a customer signs straight in. `/shop/account` (member-only, under the matrix of ADR 0022) is the customer's own points
  ledger, their last month's receipts as downloads, and the phone change — every read scoped by
  the session, so another customer's data is unreachable by construction.
- **The owner's signup door is blocked, not built.** ADR 0016 §7 has the owner continue with
  Google during *hosted* signup, then set a phone and password so the counter never waits on a
  Google session. That is ticket 08, and it assumes the hosted control plane (ADR 0016 Phase 1:
  `accounts`, `tenants`, a slug, Google authorization-code signup) which does not exist. Until
  that effort starts, the owner signs in exactly as staff do — phone and temporary password.
- **No provider is chosen**, and no OTP budget is set: the seam is here, the shop points it
  at a gateway at deploy, and `GOOGLE_CLIENT_ID` must be set for the Google door to accept
  anything.
