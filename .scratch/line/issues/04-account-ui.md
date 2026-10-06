# 04 — The account page's LINE card

**Blocking:** none beyond 02 + 03.

**Built:**

- `src/components/shop/AccountPortal.tsx`: a fifth tab, `LinePanel`. Bound
  state shows the masked subject (`U••••••abcd`), the consent notice with the
  friend reminder in the same card, and withdrawal as one act. Unbound state
  shows the OAuth bind button (`/api/v1/auth/line/authorize`) and one sentence
  of what will happen. The callback's `?line=…` result is consumed on mount and
  scrubbed from the URL.
- `src/app/(shop)/shop/account/page.tsx`: reads the binding through
  `lineBindingForUser` (what is shown is true now, the same argument as the
  phone), passes it down as a plain serialisable view.

**Acceptance, met:** `tests/line-account-ui.test.ts` — the arrangement (tab,
routes called, friend reminder present, withdrawal one act, member-only door,
no LINE path on the public list), read the way `login-staff-door.test.ts`
reads its pages.
