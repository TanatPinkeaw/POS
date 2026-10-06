# 02 — Binding and the doors

**Blocking:** 03 needs subjects to plan for; 04 needs the routes to call.

**Built:**

- `src/lib/line-identity.ts`, every write to the three LINE facts:
  - `bindLineToCustomer` — the first-sign-in path. Order is prove → decide →
    write: OTP consumed first (the number is *held*, not typed — the takeover
    argument), staff numbers refused, subjects already on another row refused,
    notice demanded only when a new customer is made. New customer = random
    password hash + notice acknowledgement + `line_bound` audit, all in one
    transaction. Consent is recorded by the same write, because binding *is*
    the yes.
  - `bindSignedInCustomer` — the account-page path. No OTP: the session is the
    proof. Same refusals, same consent.
  - `unbindLineFromCustomer` — clears subject + consent + version together
    (ADR 0030 §2's strongest form of stop); no-op when already clear.
  - `setLineNotificationConsent` — re-consent on a bound row; refuses when
    unbound, because consent without an address is dead weight.
- Routes (all `withApi`, role from the session, limiter charged):
  `auth/line`, `auth/line/link`, `auth/line/authorize` (signed state JWT, five
  minutes, session key), `auth/line/callback` (state → code → token → verify →
  bind on session → redirect), `account/line` (GET read + POST three bodies).
- Policies `line_signin` / `line_link` in `rate-limit-policy.ts`.

**Acceptance, met:** `tests/line-identity.test.ts` against real Postgres — OTP
consumed once, staff refused, notice demanded only at creation, subject taken
refused on both paths, unbind clears the trio, consent refuses unbound rows.
