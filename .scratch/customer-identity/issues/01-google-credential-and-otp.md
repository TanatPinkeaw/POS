# 01: A Google credential and a verified phone

**What to build:** A `member` can hold a Google identity alongside their phone, and the phone
can be proved by an OTP.

**Blocked by:** None.
**Status:** ready-for-agent

- [ ] A Google subject id stored on the `users` row (nullable), with a uniqueness that keeps a
      Google account from attaching to two customers.
- [ ] Verify the id token in-process against Google's JWKS with `jose` (RS256) — no
      `tokeninfo` call; a bad token is refused, never trusted for arriving over TLS.
- [ ] An OTP seam: one interface that sends and checks a code for a phone, with the SMS
      provider chosen at deploy through `.env` (the shape `NOTIFY_CHANNEL` already has).
- [ ] The OTP send door is **rate-limited** per number and per address through the shared
      limiter (ADRs 0009, 0012) — it is unauthenticated and costs money per attempt.
- [ ] Tests: a valid token is accepted and an invalid one refused; an OTP round-trips; a
      burst of send attempts is refused; the limiter is shared across processes.

## Notes

The phone is the identity and Google is only a door (ADR 0020 §2). This ticket stops at the
credential and the OTP; linking and signup are ticket 02.
