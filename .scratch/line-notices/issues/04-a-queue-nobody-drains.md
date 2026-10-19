# 04: A queue nobody drains is its own failure

**What to build:** the dashboard reports messages that are due and unclaimed, which is the one
delivery failure that leaves no trace anywhere else.

**Blocked by:** 01 (shares `outboxStalled`).
**Status:** done

- [x] `oldestDueAt()` reads the oldest `next_attempt_at` among **due** rows — not the oldest
      row, because a message scheduled for tomorrow is not late.
- [x] Dashboard reads it alongside `outboxHealth()` and computes `outboxStalled` with the same
      ten-minute grace `/admin/line` uses.
- [x] New card, above the existing "ส่งไม่ออก" one: how many are due, how long the oldest has
      waited, and the two commands that start the worker (`systemctl`, then the manual form).
- [x] The existing `abandoned` card is untouched — the two failures are distinct and a shop
      needs to tell them apart: one gateway refused, the other nobody was listening.

## Notes

No heartbeat table. The queue already carries the timestamp, and a second thing to keep in
step is a second thing to get wrong. `waitingMinutes` is null when nothing is due, which the
card renders as a shorter sentence rather than "0 นาที".
