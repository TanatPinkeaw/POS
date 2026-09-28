# ADR 0007 — Telling people things: an outbox, and no provider of ours

**Status:** accepted (2026-09-28)
**Context:** SRS §3 replaced half of the pre-order experience with a chime. A
customer learns their parcel is ready only by looking at the app, and a shop learns
it has an order only by being near the screen — which, at a small shop, is exactly
where the counter is not. The gap analysis (§4.2) had this second in the build
order behind refunds, for one reason: without a channel, "notifications" is a table
nobody reads.

## Decisions

### 1. The message is written in the transaction that made it true

`notifications` rows are inserted inside the order transaction — `placePreOrder`
and `markOrderReady` — not posted after it. This is the whole reason the table
exists rather than a `fetch` in the route handler.

The alternative is what most systems do first, and its failure mode is silent: a
process that dies between the commit and the send leaves an order that changed and
a customer who was never told. With the row written first, that process leaves a
row for the worker to pick up on its next pass, and the two outcomes are "order
changed and message queued" or neither.

### 2. One channel, chosen by the shop, and both of them are a URL the shop owns

`NOTIFY_CHANNEL=line|webhook`. Unset means **nothing is queued at all** — not a
backlog of undeliverable rows. The in-app and on-screen path stays as it is, and
that path is not degraded: the board chimes, the customer's order screen updates
over the socket, and the queued row simply never exists.

No provider of ours, for the same reason the bank bridge reads the shop's own
mailbox (ADR 0005): an SMS account is a subscription, a per-message fee, and a
company that can change its terms. `webhook` is a JSON POST to whatever the shop
likes — Twilio, a Thai gateway, or twelve lines of script — and `line` is the LINE
Messaging API, which is where Thai shops actually talk to their staff.

`line` was chosen as a first-class channel rather than an afterthought, and it
shaped decision 3.

### 3. A customer's collection code never goes to the shop's LINE group

The planner (`src/lib/notify-message.ts`) returns **null** for a customer message on
a LINE channel. A LINE push addresses a LINE user id; the only id this shop has is
its own staff group, and a phone number is not one. Pushing the code there would put
every waiting parcel's PIN into a room of staff phones — while the customer, the
only person entitled to it, already has it on their own order screen.

So the rule is small and absolute: **the shop's own group gets facts about orders;
the customer's phone gets the code.** It is a pure function with a unit test rather
than a comment, because it is the kind of thing a later change adds "just one
message" to.

### 4. Claiming is a conditional UPDATE, so a crash cannot lose or duplicate a send

The worker reads the due ids, then claims each by moving `next_attempt_at` forward
*before* it sends. The claim is the ownership: a second worker finds nothing to
claim, and a worker killed mid-send leaves a row that comes back rather than one
stuck in flight.

`UNIQUE (kind, order_id)` is the second half — "your order is ready" is a fact about
one order, so a retried request, a double click and a second worker pass all produce
one message. The dedupe is in the database rather than in the sender, because the
sender is a script somebody may run by hand.

### 5. A schedule that gives up, rather than one that retries forever

`src/lib/notify-retry.ts` is pure and short: attempts at roughly 1, 5, 15, 60 and
360 minutes, then stop. Six attempts over about eight hours — long enough to ride
out a gateway's bad morning, short enough that a misconfigured shop sees the failure
on the same working day.

Giving up is its own state (`abandoned`), with the gateway's own words kept in
`last_error`, and the dashboard grows a card that appears only when there is one.
The alternative — retrying until somebody notices the log — is a shop that believes
it is sending texts.

### 6. The transport is the only part that knows about HTTP

`notify-channel.ts` owns the two `fetch` calls, the ten-second timeout and the error
messages. Two consequences worth stating:

- **A failure is a message, not a stack trace.** A refused connection, a DNS
  failure, a 502 and a timeout all arrive as `NotificationDeliveryError` with
  something a person can act on, because that string is what lands in the row.
- **The URL never appears in an error.** A gateway URL routinely carries its
  credential in the query string, and `last_error` is shown to a manager; errors
  name the host and nothing else.

The row's own `channel` decides the transport, not the environment: a message queued
yesterday under a LINE configuration is still a LINE message, and sending it through
a gateway configured since would deliver it somewhere else — or nowhere, while
reporting success.

## Consequences

- A shop with `NOTIFY_CHANNEL` set gets what the SRS asked for: the customer is
  told, and the counter hears about an order from wherever it is.
- The worker is a script the shop has to run (`npm run notify:worker`, cron or
  `--watch`). That is the same trade as the bank bridge, and the same limitation.
- The dashboard has one more conditional card, which is now three; the pattern is
  deliberate and worth watching — an owner who learns to skip cards has learned
  nothing.
- Known limits: no per-staff routing (one destination for the shop), no delivery
  receipts (a 200 means the gateway took it, not that a phone received it), no
  template editing from the UI, and no way to cancel a queued message from the app
  (the `requeueNotification` helper is the repair path that exists).
- LINE messages go out under a channel nobody has configured user ids for, so today
  `line` means "the shop's own group". Customer messages on LINE are a future
  decision, not an oversight — it needs the LINE user id captured at order time,
  which is a schema change and a consent question.

## Revisit when

- A shop wants customer messages on LINE. That needs a user id per member, captured
  with their consent, and it reopens decision 3 in a good way rather than around it.
- Notification volume justifies a queue with priorities — a "ready for pickup" alert
  should not queue behind a week of marketing.
- The unattributed-transfer card and this one both exist on one screen. If a fourth
  appears, the dashboard needs a single "needs a person" list rather than another
  conditional card.
