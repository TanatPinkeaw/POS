# 03: A customer's message is recorded, once, whatever LINE does

**What to build:** The webhook stops throwing `message` events away. Every message a
customer sends the shop's Official Account becomes one row, tied to the customer row it
came from when one exists — because LINE says a LINE Login `sub` and a Messaging API
`userId` are the same value for the same person under one provider, which is what makes
`source.userId` matchable to `line_subject`.

**Blocked by:** None.
**Status:** done

- [ ] Schema + migration: `line_messages` — `id`, **`line_message_id` UNIQUE** (LINE's own
      message id), `line_subject`, nullable `user_id` (FK to `users`, `onDelete: SetNull`
      so a deleted customer does not erase the shop's record of what was asked),
      `message_type` (text/image/video/audio/file/location/sticker),
      nullable `text`, `received_at`. Indexes: `(user_id, received_at desc)` for the
      customer's card, `(received_at desc)` for anything that reads the log whole.
- [ ] The dedupe is **the platform's own identifier**, exactly as `inbound_payments` uses
      the bank's `Message-ID`: LINE redelivers a webhook it did not get a 2xx for, and a
      redelivery must be a no-op rather than a second row. Prisma's `upsert` on the unique
      column, not a read-then-write.
- [ ] No bytes are fetched for a non-text message: the row records `message_type` and no
      body. This deployment holds no files (ADR 0014/0025 — a photo is a link), so
      downloading a customer's picture would create storage nothing here can back up.
- [ ] `src/app/api/v1/line/webhook/route.ts` writes the row inside its existing loop,
      after the signature has held, beside the `follow`/`unfollow` handling it already
      does. Still answers 200 for everything: the reply that matters is "received".
- [ ] `src/lib/line-messages.ts` owns every read and write of that table (the same split
      as `inbound-payments.ts`), with the pure part — deriving `message_type` and whether
      a text body exists from a webhook event — separated so it is tested without a
      server. A text message with no `text` field, and an unknown `message.type` from a
      future LINE version, are both cases the pure function answers rather than throws.
- [ ] `tests/helpers/test-db.ts` gains `line_messages` in its truncation list.
- [ ] Tests against real PostgreSQL (`tests/line-messages.test.ts`): the same event twice
      is one row; a message from a bound subject resolves to that customer;
      a message from a stranger is recorded with a null `user_id`; a sticker stores its
      type and no text.

## Notes

**Why a table and not a log line.** A log line answers "did something arrive"; this
answers "what did this customer ask us", which is the question a shop asks when the
customer is standing at the counter. The retention decision is deliberate and recorded
in the ADR: kept like an order, with no window — and named in the PDPA posture as
customer data on our hardware.
