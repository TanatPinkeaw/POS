# 02: Two doors to a customer, and one identity per phone

**What to build:** A customer signs up with Google and a verified phone, or is enrolled at the
counter; a returning member's Google sign-in links to the row that already owns their number.

**Blocked by:** 01.
**Status:** done

- [x] Self-signup: Google, then a phone confirmed by OTP, creating a `member`.
- [x] Counter enrolment (ADR 0011) unchanged and still working, with no Google required.
- [x] A first Google sign-in with a phone that already belongs to a member **links** to that
      row after OTP proves possession — never a second row, never a refused sign-in.
- [x] The phone stays unique across every role; a number a staff account holds is refused as a
      customer, and vice versa.
- [ ] `/shop` offers both doors side by side; neither is hidden — **deferred to ticket 07**
      (the customer portal), which already owns the `/shop/*` screens. The two doors exist as
      API calls (`/api/v1/auth/google`, `/api/v1/auth/signup`, `/api/v1/auth/otp`); the sign-in
      surface that offers them arrives with the portal. Recorded in README *Not built yet*,
      ADR 0020's gaps and `docs/roadmap.md`.
- [x] Tests: linking keeps the points and the order history on one row; a second sign-up
      cannot take a number already owned; a walk-in enrols and later links without a second
      customer.

## Notes

The failure to prevent is a split balance (ADR 0020 §4). "Link, never duplicate" is the whole
ticket.

## Continuation checkpoint

**One rule module, one order.** `src/lib/identity.ts` holds the entire decision and its
sequence is the decision:

1. **A Google subject already on a row** signs in, with no code — the phone is verified at
   signup and on a change, not on every visit (ADR 0020 §5). The same subject arriving with a
   *different* phone is refused (`GOOGLE_ACCOUNT_ALREADY_LINKED` 409): moving a number is a
   step-up act (ticket 03), not a side effect of signing in.
2. **The phone is proved** by consuming the OTP *before* anything is written, so a bad or
   expired code cannot create a row or attach a credential.
3. **Who already owns the phone** decides: a staff number is refused
   (`PHONE_BELONGS_TO_STAFF` 409); a member's row has the subject *attached* — the same row, so
   the points and the order history stay put, and deliberately **not renamed** (linking a door
   is not a rename); a number nobody owns makes a `member` with a random bcrypt hash, so the
   phone-and-password door is closed until the customer sets a password of their own.
4. The unique index on `phone` and on `google_subject` is the backstop under the two reads a
   race could slip between: the losing insert is caught as `P2002` and answered as the same
   `DUPLICATE_ACCOUNT` conflict a second sign-up should see.

**Two routes, two answers.** `POST /api/v1/auth/google` verifies the id token; a known subject
starts a session and answers like the password door, an unknown one answers
`{ linked: false, needsPhone: true, fullName, email }` and writes **nothing** — there is no
half-created customer and no pending identity held server-side, so a caller who walks away
leaves no row. `POST /api/v1/auth/signup` carries the id token again (re-verified), the phone
and the code, calls `completeCustomerGoogleSignIn`, starts the session, and returns
`created`/`linked` so the screen can say which happened. Audits: `member_updated`
`{ fields: ['google'] }` on a link, `member_created` `{ phone, via: 'google' }` on a create.

**Tests.** `tests/customer-signup.test.ts` (10) drives the rule directly: a new phone makes a
customer; the Google name is taken as a fallback and the typed name preferred; a phone a member
already has **links to that id** with the points (120) and the row count (1) unchanged; the
second visit is a plain sign-in with no code; a staff number is refused and the staff row's
`google_subject` stays null; a second Google account on a linked number is refused; the same
Google account on a different phone is refused with the second phone still nobody's; a wrong
code and a never-sent code both create nobody. In real HTTP and a real database,
`scripts/acceptance.ts` now drives the whole path against a **JWKS the run serves itself**
(`GOOGLE_JWKS_URL`, port 3313, signed with a generated RS256 key): the unknown account is asked
for a phone and shown the Google name; the code completes a signup and starts a session; a
second visit with the same subject signs straight in; a number the counter enrolled links to
that row with its 120 points and stays one row; a second Google account is refused (409); and a
staff number is refused (409). Acceptance is **166 checks** (was 156); `npm test` is **1005
tests across 68 files**; `npm run verify:all` passes all five gates in 4m36s.

**One honesty note.** The doors are built and exercised, but there is **no `/shop` sign-in
screen** yet: the ticket's two-doors item is deferred to the portal (ticket 07), which is where
`/shop/*` lives. Until then the counter flow (ADR 0011) and the API are how a customer exists.

Source: ../spec.md and ../../../docs/adr/0020-a-customer-signs-in-with-google.md.
