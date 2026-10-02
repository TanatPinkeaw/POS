# 08: The owner's signup door

**What to build:** The shop's owner signs up with Google during hosted signup, then sets a
phone and password for daily use.

**Blocked by:** 01. (Depends on the hosted control plane, ADR 0016 Phase 1.)
**Status:** ready-for-agent

- [ ] Signup continues with Google, creating the **account** that pays us (the control plane),
      separate from the shop's `users`.
- [ ] After signup the owner sets a phone number and a password, so the counter never depends
      on a live Google session.
- [ ] The owner's day-to-day sign-in is phone and password, like staff.
- [ ] Tests: a signup links an account to a shop; the owner can sign in by phone and password
      afterwards without Google; the account and the shop's `users` are distinct rows.

## Notes

Google is the **signup** door and the **customer's** door, never the counter's (ADR 0020 §1,
§7). This ticket belongs to the hosted work; it is listed here so the identity split lives in
one place, and it can be deferred until the control plane exists without blocking 01–07.

## Known gap

None of the hosted control plane exists yet (ADR 0016); this ticket assumes it does.
