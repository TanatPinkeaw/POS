# 09: The documents, and what "green" means here

**What to build:** ADR 0035, the env documentation, the operator's runbook, and the checks that
make the above a measurement rather than a belief.

**Blocked by:** 01–08.
**Status:** done

- [x] `docs/adr/0035-the-customer-is-told-about-their-own-order.md` — the gate that made the
      message invisible, the five kinds and why the reminder needs its own, why blocked
      messages are still not queued, the two readers of one readiness rule, the third delivery
      failure, the receipt's stated expiry, the consent scope, and the rejected alternatives.
- [x] `.env.example` — `NOTIFY_CHANNEL=line` is named as the gate on everything said to a
      customer, with `NOTIFY_LINE_TOKEN` distinguished; `PICKUP_REMINDER_HOURS` documented.
- [x] `docs/renter-onboarding.md` §6.2 — the five customer messages, the reminder switch, the
      setting people get wrong, how to check it (`line:wizard`, `/admin/line`), and the card's
      line as the counter's answer.
- [x] `npm run doc:audit` still passes: no new npm script was added, so the command tables do
      not move.
- [x] `tests/customer-notices.test.ts` — the wiring, not the planners: one journey earns
      accepted → ready → receipt to the customer's own subject; a staff cancellation tells and a
      member's own does not; the expiry tells; the reminder queues once and a second pass queues
      nothing; a webhook shop still texts the ready note and gets none of the LINE-only four.
- [x] `npm run typecheck`, `npm test`, `npm run verify`.
- [x] `npm run route:audit` — `/admin/line` must render only classes its CSS defines; a new
      Card and Pill are DS components, and the panel's own module is loaded by the page.
- [x] The acceptance journey is **not** changed: it runs on `NOTIFY_CHANNEL=webhook` with no
      LINE-bound member, so the four new planners correctly queue nothing and the pinned kinds
      list stays exactly as it was. Recorded in the ADR so the next round does not "fix" it.

## Notes

A gate that cannot fail is not a gate. What this ticket buys is that the next person asking
"does the customer get told?" has three answers that agree — the wizard, the admin screen and
the card — instead of one tool that lied confidently.
