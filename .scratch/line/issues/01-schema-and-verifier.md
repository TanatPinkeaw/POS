# 01 — Schema and the verifier

**Blocking:** everything else in this feature.

**Built:**

- `prisma/schema.prisma`: `users.line_subject` (nullable, unique — the Google
  column's shape), `users.line_consent_at` + `line_consent_version` (a timestamp
  pair, no "no" state), standalone `line_friends` keyed by subject (no FK, like
  `otp_challenges` — the webhook writes by subject before any binding exists).
- `prisma/migrations/20261006000000_line_door/`: the columns, the index, the
  table, **and the two audit enum values** (`line_bound`, `line_unbound`) — the
  enum lives in the same migration because a trail whose vocabulary lags the door
  by one round is a trail that misses the first bindings.
- `src/lib/line-id-token.ts`: in-process verification against LINE's JWKS, RS256
  pinned, `LINE_LOGIN_CHANNEL_ID` as audience, issuer `https://access.line.me`,
  operator-overridable `LINE_JWKS_URL` for the acceptance run.

**Acceptance, met:** `tests/line-id-token.test.ts` (the Google forgery catalogue,
re-pointed at LINE: wrong key, wrong audience, wrong issuer *including
Google's*, expired, HS256 confusion, no subject, junk, unconfigured) and
`tests/line-identity.test.ts` (unique index answers the race; nulls are
distinct). `npm run db:generate` client committed.
