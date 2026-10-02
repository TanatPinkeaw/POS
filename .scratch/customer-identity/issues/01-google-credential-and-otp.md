# 01: A Google credential and a verified phone

**What to build:** A `member` can hold a Google identity alongside their phone, and the phone
can be proved by an OTP.

**Blocked by:** None.
**Status:** done

- [x] A Google subject id stored on the `users` row (nullable), with a uniqueness that keeps a
      Google account from attaching to two customers.
- [x] Verify the id token in-process against Google's JWKS with `jose` (RS256) — no
      `tokeninfo` call; a bad token is refused, never trusted for arriving over TLS.
- [x] An OTP seam: one interface that sends and checks a code for a phone, with the SMS
      provider chosen at deploy through `.env` (the shape `NOTIFY_CHANNEL` already has).
- [x] The OTP send door is **rate-limited** per number and per address through the shared
      limiter (ADRs 0009, 0012) — it is unauthenticated and costs money per attempt.
- [x] Tests: a valid token is accepted and an invalid one refused; an OTP round-trips; a
      burst of send attempts is refused; the limiter is shared across processes.

## Continuation checkpoint

**The Google credential.** `src/lib/google-id-token.ts` verifies a Google id token in process
with `jose`: `RS256` against Google's published JWKS (fetched once per process by
`createRemoteJWKSet`), audience pinned to this deployment's `GOOGLE_CLIENT_ID`, issuer pinned
to Google's both published forms. Every failure — bad signature, wrong audience, wrong issuer,
expired, junk — is one `InvalidGoogleCredentialError` (401), so a caller learns nothing about
their forgery. `users.google_subject` is a nullable, unique column (migration
`20260119000000_customer_identity_seams`), so a Google account belongs to exactly one
customer while every counter-enrolled customer keeps it NULL.

**The OTP seam, split by what each half needs.** `src/lib/otp.ts` is pure policy plus the
provider seam: `OTP_CODE_LENGTH`, `OTP_MAX_ATTEMPTS`, `otpTtlMinutes()` (`OTP_TTL_MINUTES`,
default 5), `generateOtpCode` from a CSPRNG, `otpCodeExpiry`, and `readOtpChannelConfig` — the
same `.env` shape as `NOTIFY_CHANNEL` (`OTP_CHANNEL=webhook`, `OTP_WEBHOOK_URL`,
`OTP_WEBHOOK_SECRET`), with a delivery that never logs or returns a token-bearing URL.
`src/lib/otp-store.ts` is persistence: one row per phone in `otp_challenges`, the code stored
**bcrypt-hashed**, replaced on each send (so a "send again" leaves one live code, not two), and
consumed by an *atomic* conditional update so a correct code can only win once.

**The door.** `POST /api/v1/auth/otp` is unauthenticated by necessity and spends two buckets
before any work: `otp_send_number` (keyed by address *and* number, like `login_failure`) and
`otp_send_address` (address alone, so walking a list of numbers spends that one). It refuses
`503` when no channel is configured and `502` when the gateway cannot be reached, and it runs
for *any* well-formed number — refusing an unknown number would be an account-enumeration
oracle, and proving a brand-new number is exactly what a first signup needs.

**Tests.** `tests/google-id-token.test.ts` (11) verifies against a locally generated RSA key
pair and refuses a foreign key, another app's audience, another issuer, an expired token, an
HS256 token offered where RS256 was expected, a token with no subject, and junk.
`tests/otp.test.ts` (11) pins the code shape, expiry, `.env` reading, and delivery failures.
`tests/customer-identity.test.ts` (9) is the real-PostgreSQL half: the `google_subject` unique
constraint (and that NULLs do not collide), and a challenge that round-trips once, survives a
wrong guess, dies on expiry, dies at the attempt ceiling, is replaced by a second send, and can
be forgotten. `scripts/acceptance.ts` now (5 checks, a new section 15) stands up an OTP gateway
it owns, sends a code, proves it reaches the gateway addressed to the number as a six-digit
code, refuses the fourth send to one number with a 429, and shows a *different* number still
sends — the per-number keying, end to end. Acceptance is 156 checks (was 151).

**The limiter is shared across processes** is the existing `tests/rate-limit.test.ts` property
(the buckets are rows, read back by a restarted module), and the two new policies are covered
by it: `otp_send_number`/`otp_send_address` live in the same table and are keyed by the same
pure `bucketKey`. Nothing about the store changed for them.

**One honesty note.** This is the credential and the proof, not the customer: nothing yet turns
a verified Google credential plus a proved phone into a `users` row or attaches the subject to
an existing one — that is ticket 02, and until it lands the counter flow (ADR 0011) remains the
only way a customer exists. The OTP *check* is a function (`consumeOtpChallenge`) with no route
of its own, because the only caller that should ever present a code is the signup/link route
ticket 02 adds.

Source: ../spec.md and ../../../docs/adr/0020-a-customer-signs-in-with-google.md.
