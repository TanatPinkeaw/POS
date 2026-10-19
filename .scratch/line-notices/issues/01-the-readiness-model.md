# 01: One pure answer to "would a customer be told?"

**What to build:** `src/lib/line-readiness.ts`, the module both the wizard and the admin panel
read, so the two cannot disagree about whether the shop is notifying customers.

**Blocked by:** nothing.
**Status:** done

- [x] `lineReadiness(env)` returns five doors — `customer_push`, `webhook`, `sign_in`,
      `liff_entry`, `campaigns` — each with `state`, the missing values, and one Thai sentence.
- [x] `ready` = every value present, `blocked` = **some** present, `off` = none. The middle
      state is the dangerous one and the reason a boolean was not enough: a shop that never
      set LINE up is fine, a shop that set half of it believes it is sending.
- [x] `customer_push` requires `NOTIFY_CHANNEL=line` (**the value**, not the key),
      `NOTIFY_LINE_TOKEN`, and `LINE_MESSAGING_CHANNEL_SECRET` — the last because
      `line_friends` is written by the webhook, so without it no customer is ever a friend and
      the planner refuses at the final condition.
- [x] The `missing` label for the channel is `NOTIFY_CHANNEL=line`, because "set it" is not
      the instruction.
- [x] `outboxStalled({ dueNow, oldestDueAt, now })` — stalled only **past** a ten-minute
      grace, and a due count with no timestamp is treated as stalled rather than fine.
- [x] `tests/line-readiness.test.ts`: the token-without-channel case, a `webhook` shop, a
      blank value, `off` vs `blocked`, the grace boundary, and the missing-timestamp case.

## Notes

The wizard's old line was the bug this module exists for: it read two values and printed a
third value's verdict. Splitting the rule out is also what lets `/admin/line` answer from the
process's environment while the wizard answers from the file — and their disagreement is the
finding, not a nuisance.
