Tickets for the LINE integration (ADR 0030). All were built in one round, in
this order; the edges below are the order the *code* depends on, kept so a
re-work starts at the right one.

- [01-schema-and-verifier.md](01-schema-and-verifier.md) — columns, friend table,
  audit enum, `line-id-token.ts`. Everything else imports these.
- [02-binding-and-doors.md](02-binding-and-doors.md) — `line-identity.ts` and the
  five auth/account routes. Depends on 01.
- [03-messages.md](03-messages.md) — planners, `markOrderReady` / refund /
  dismissal enqueue, webhook. Depends on 01 (friend table) and 02 (subjects
  exist to plan for).
- [04-account-ui.md](04-account-ui.md) — the LINE tab. Depends on 02 + 03.
- [05-provisioning-and-docs.md](05-provisioning-and-docs.md) — wizard, env
  sample, README/AGENTS/onboarding. Depends on everything above naming its env
  vars.
