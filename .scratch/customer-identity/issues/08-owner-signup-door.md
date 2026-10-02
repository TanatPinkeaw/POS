# 08: The owner's signup door

**What to build:** The shop's owner signs up with Google during hosted signup, then sets a
phone and password for daily use.

**Blocked by:** 01 **and the hosted control plane (ADR 0016 Phase 1), which does not exist.**
**Status:** blocked — deferred until the hosted effort starts

## Why it is blocked (checked, not assumed)

The ticket's premise is a hosted signup that creates an **account** distinct from the shop's
`users`. None of that is in the tree: there is no `accounts` or `tenants` model, no slug, no
Google authorization-code flow (only the id-token verification of ticket 01), no host-based
tenant resolution, and `src/app` has no hosted signup route. Building this ticket means building
ADR 0016 Phase 1 first — a separate, large effort, not one ticket. So it is deferred here, which
the ticket's own note already permits ("it can be deferred until the control plane exists
without blocking 01–07"), and 01–07 are all done. The shop's owner signs in today exactly as
staff do: phone and temporary password.

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
