# 07: One reminder before the hold ends

**What to build:** a customer is reminded once, `PICKUP_REMINDER_HOURS` before their parcel's
hold expires — derived from the order, written by the notify worker.

**Blocked by:** 06 (the helper and the planner style).
**Status:** done

- [x] `planLineCustomerReminderMessage` — the hold time in Bangkok and the PIN again, because
      the customer may have scrolled past the first message.
- [x] `enqueueDuePickupReminders(now)` in `orders.ts`: `ready_for_pickup`, hold between now and
      the horizon, a PIN present, a bound customer, and **`notifications: { none: {
      kind: 'order_reminder' } }`** so a repeated pass costs one query and writes nothing.
- [x] `pg_try_advisory_xact_lock('pos:pickup-reminder')` — the sweep pattern the expiry
      sweeper already uses; without it two instances enumerate the same parcels and the unique
      index turns the loser's work into an exception instead of a no-op.
- [x] The friend set is read **once** for the batch, not per order: twelve parcels must not pay
      twelve queries.
- [x] `gt: now` as well as `lte: horizon` — a hold that already ended is not a reminder, it is
      a late parcel, and telling somebody about a deadline that passed is worse than silence.
- [x] Called from `scripts/notify-worker.ts`'s `pass()`, between the outbox drain and the
      campaigns, so the rows it writes can go out in the same pass. `PICKUP_REMINDER_HOURS=0`
      makes the window empty, which is how it is turned off.
- [x] `take: 100` bounds a worker started after a week of downtime.

## Notes

The kind is `order_reminder` and not `order_ready` for a mechanical reason: `(kind, order_id)`
would make the reminder a duplicate of the ready message and it would never leave. That is the
single strongest argument for one kind per fact.
