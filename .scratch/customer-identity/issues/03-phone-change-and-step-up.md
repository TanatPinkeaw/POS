# 03: Changing a phone proves the new number

**What to build:** A customer can change their phone, and the change is confirmed by an OTP on
the new number before it takes effect.

**Blocked by:** 01.
**Status:** ready-for-agent

- [ ] Changing a phone requires a fresh OTP on the **new** number; without it the change is
      refused.
- [ ] A new number already owned by another identity is refused, as enrolment already refuses
      a taken number.
- [ ] The change is audited (a phone is the identity, so this is a security event).
- [ ] Signing in does **not** require an OTP — only signup and phone changes do.
- [ ] Tests: a change with no OTP is refused; with a wrong OTP is refused; with the right one
      takes effect and is audited; the refusal names the reason in Thai.

## Notes

OTP-once means a reassigned number can later be captured (ADR 0020, known gaps); re-proving on
every change is the mitigation this ticket implements.
