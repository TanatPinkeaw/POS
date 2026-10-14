# 04: The shop hears about a message, once per burst

**What to build:** A customer's message reaches the shop's own group — as **one fact per
quiet window per customer**, not one per message — and the same customer's card at
`/admin/members` shows their recent messages.

**Blocked by:** 03 (there is nothing to alert about until the message is a row).
**Status:** done

- [ ] Schema + migration: a nullable `dedupe_key` on `notifications` with
      `@@unique([kind, dedupe_key])` beside the existing `@@unique([kind, order_id])`.
      Postgres treats nulls as distinct, so every row written today is unaffected — the
      index only constrains the rows that fill the column.
- [ ] The reason this exists, stated where the column is: the outbox's dedupe for a
      message that belongs to no order is `(kind, recipient)`, i.e. **once ever** — right
      for a dismissed transfer, wrong for a burst of messages. A key built from the
      subject and a **time bucket** gives one fact per customer per window, enforced by
      the index rather than by a read that two workers could both win.
- [ ] `enqueueNotification` mirrors whichever shape a plan names: `order_id` when the
      fact is about an order, `dedupe_key` when it carries its own key, and today's
      `recipient` read for the shapes that have neither. The read stays a read; the index
      is what makes the duplicate impossible.
- [ ] `planCustomerMessageFact` in `line-notify.ts`: the shop's own destination only (a
      group id or the webhook address — the same rule as every other shop fact), the
      sentence naming who wrote and what the shop's next move is, and `null` when the
      shop has configured nothing (unset means nothing is queued, as always).
- [ ] Window: one fact per customer per 10 minutes, the bucket computed from **Bangkok
      time** through `src/lib/bangkok-time.ts` (rule 10), and the constant named and
      commented rather than inlined.
- [ ] `MembersManager` shows that customer's recent messages (newest first, a short list
      with the count) in the surface that already opens per customer. Read through
      `line-messages.ts`; the customer list query is unchanged, so a shop with no LINE
      customers pays nothing.
- [ ] Tests: pure (the bucket key is stable inside a window and different across two;
      a plan is null with no shop destination), and against real PostgreSQL — five
      messages in one window write one notification; the same customer in the next window
      writes another.

## Notes

**Why not one per message.** Two measured facts, both in the ADR: LINE's own Official
Account app already notifies staff when a customer writes (that is how manual chat
works, and it is what this system does not try to replace), and a push into a group is
counted **once per member of the group**. A fact per message would be a duplicate alert
that also spends the month's allowance. The card is where the detail lives, because that
is the one place this system knows something LINE's own app cannot show: which customer
this is and what they have bought.
