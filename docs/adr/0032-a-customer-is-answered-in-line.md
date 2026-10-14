# ADR 0032 — A customer is answered in LINE, and the shop can say something to all of them

**Status:** accepted (2026-10-14). **Amends ADR 0030**, whose *known limits* named exactly
these three things — the LIFF surface, broadcast, and answering a customer — and
**depends on ADR 0007** for the outbox, the one transport, and the rule that a fact is
queued in the same transaction as the act that made it true.

**Context.** ADR 0030 built the door: a customer signs in with LINE, binds by OTP,
consents, and their collection code arrives on their own LINE. It left three facts about
the code it shipped, and each is why this effort exists.

- **There was no in-LINE surface.** The redirect flow finishes in a browser, and inside
  LINE that means the customer walks LINE's screens and lands back on the shop's ordinary
  pages — which do render there. But a customer holding a LINE account in LINE's own
  browser having to walk a web sign-in is a step nobody needed.
- **A customer's message was thrown away.** The webhook received `message` events and
  recorded nothing, so the one channel the shop's customers actually use carried no
  history this system could read.
- **The shop could only send one customer at a time, and only about an order.** Every plan
  the outbox could produce was tied to an order or a bank transfer. There was no way to
  tell customers who said yes that the shop has something to say.

The facts this rests on are LINE's, read from LINE's own documentation rather than
remembered, and they are the reason several decisions below are shaped the way they are:
push, multicast and broadcast are each counted **per recipient** against a monthly
allowance (**300 messages on Thailand's free plan**), and over it LINE answers
**429 `You have reached your monthly limit.`** — while its documentation warns the same
error can arrive with messages still showing as left. A push into the shop's own group
therefore costs **one message per member of that group**, not one per group, which is an
arithmetic every existing shop fact was already paying. `POST /v2/bot/message/multicast`
takes **at most 500 user ids**; `POST /v2/bot/message/broadcast` goes to *every* friend of
the Official Account and takes **no recipient list**, so it cannot honour a consent rule.
There is **no live friend-count API**, so the size of an audience must come from this
deployment's own rows. A LIFF app is registered **inside the existing LINE Login
channel** as a second registration with its own `liffId`, its endpoint URL must be
**HTTPS** and may be a route of this deployment, and `liff.getIDToken()` returns a token
signed **ES256 with the channel id as audience** — the exact shape
`src/lib/line-id-token.ts` already verifies for the SDK path. A LINE Login `sub` and a
Messaging API `userId` are **the same value for the same person when both channels sit
under one provider**, which is what lets a webhook event be matched to a customer row by
`line_subject`. An image message carries `originalContentUrl` and `previewImageUrl`, both
HTTPS; **the exact size and format limits could not be confirmed from primary sources**,
so no number is asserted anywhere in this repository.

## Decisions

### 1. The in-LINE entry is a door, not an identity — and the phone stays the identity

`/line` is the LIFF app's **endpoint URL**, and it is the *only* thing registered for this
feature: no second channel, no second token, no new identity. The customer who arrives
there has a LINE account in hand; the entry turns that into the session every other
customer screen already uses and then gets out of the way. The catalogue, the orders and
the e-receipt are the pages that exist, rendered in LINE's browser exactly as they are
anywhere else.

That is the first decision because the alternative is the drift this repository refuses:
writing a narrower in-LINE renderer of screens that already work would be a second
implementation of the customer area, kept in step by hand forever.

`@line/liff` is a **dependency taken on for a feature rather than written here**, which
is unusual enough to justify: LIFF's handshake is LINE's own protocol, exercised against
LINE's servers, and there is no wire format this project could speak by hand without
reimplementing an SDK badly. It is **bundled** rather than loaded from LINE's CDN, so the
script is same-origin and no CSP exception is needed; and `browser:target` measures it
against the Safari 15.6 floor like every other chunk (ADR 0031), because that floor has
already bitten this repository once. If a future SDK carries syntax the floor cannot
parse, the answer is a pinned older SDK — never a weakened gate.

**What the entry decides is a pure function, and the SDK is the adapter.**
`src/lib/line-liff-entry.ts` takes facts — is this deployment configured, is the browser
inside LINE, did the call fail, did the server answer with a session — and returns one of
`unconfigured | open_in_line | sign_in | claim | signed_in | failed`, with a Thai sentence
for each. No `liff` import, no `window`, so every decision is a unit test rather than a
promise in a comment; `LiffEntry.tsx` is the adapter that initialises the SDK and does what
the module said. The split is `line-door.ts`'s, and for its reason: the SDK cannot run in a
test, so the part worth testing must not need it.

The order of the rule is the decision. Configuration beats failure — a missing
`LINE_LIFF_ID` did not fail, it was never set up. Failure beats the browser check — an
honest error is worth more than "open this in the app". A server answer beats everything it
can. And `open_in_line` exists because LIFF initialises in an external browser too: a
customer who arrives there did not come from the shop's chat and would be asked to log
into LINE itself, so the entry names the app and offers the ordinary doors at `/login`
instead. **Unset means a door that is not a door**: with no `LINE_LIFF_ID` there is no
entry to hand anybody, so `/line` says so and points at `/login`, the way
`lineCustomerNotifyBlock` and the webhook already treat "unconfigured".

**A first sign-in finishes inside LINE, through the route ADR 0030 already built.** The
entry posts `liff.getIDToken()` to the **existing** `POST /api/v1/auth/line` — the
id-token door ADR 0030 §1 specified for a browser that holds one and that no screen had
ever used. A session comes back, or the answer is `needsPhone`, and then the **same**
`LineClaimStep` the front door renders appears in this page: phone, code, name, notice.
`POST /api/v1/auth/line/link` already accepts an id token *or* the redirect flow's
httpOnly handoff and prefers the id token when one was sent, so nothing new was written on
the server for this — only a prop threaded to an existing form.

The **OTP stays even here**, deliberately rather than by leftover. The LIFF browser is the
customer's own LINE account, but the number is what is being anchored and a person can
type somebody else's; §1 of ADR 0030 answers that with a code sent to the number, and this
ADR does not reopen it. What changes is only *where* the form renders: keeping it in
LINE's browser is what stops a first sign-in dying at the app's boundary.

**Not persisted.** The id token is read once per render and lives in a `useRef`; it is a
credential, and the session cookie is what the rest of the app uses. The proof is spread
into the claim request **only when there is one**, because an empty string would be a
*sent* id token that verifies against nothing — which the route would answer as LINE's
failure rather than as the handoff cookie it could have used.

**Alternatives rejected.** Sending the customer to `/login?line=claim` from inside LINE,
which works and was the smaller change: it throws the customer out of the app for a form,
which is the one place a first sign-in is most likely to be abandoned. A LIFF-only
identity that binds without the OTP: the takeover ADR 0030 §1 exists to refuse. A third
token audience for the LIFF path: the id token's audience is already LINE's own channel
id, which is strictly better evidence than anything this deployment could mint. And
re-implementing the customer area for a narrower viewport: two renderers of the same
pages.

`/line` is a **public route** (`isPublicPath`) and is walked signed out by `route:audit`,
because that is the only way a LIFF entry is ever opened.

### 2. The ready message carries the door

The order-ready text on the customer's LINE gains the entry link —
`https://liff.line.me/<liffId>` — built by **one** function (`liffEntryUrl`) for every
caller, exactly as `lineRedirectUri` is for the callback. A second assembly is how one of
them drifts, and a message pointing at `https://liff.line.me/` would open LINE with no app
in it.

It is appended **only when this deployment has a LIFF app**, so a shop that never set one
up gets exactly the sentence it sent before rather than a link to nowhere. Nothing secret
rides the link: the collection code is already in the text beside it, and the link only
saves the customer from finding the shop again inside LINE.

### 3. A customer's message is recorded, deduped on LINE's own message id

`line_messages` is one row per inbound message: LINE's message id (unique), the LINE
subject, the customer row when this deployment holds one, the message kind, and text —
**only** for a text message, which a CHECK enforces. A non-text kind stores its kind and
**no bytes**: this deployment holds no files (ADR 0014), and a customer's photo is not
something this box could back up or vouch for.

The dedupe is LINE's own message id and it is the **database's** — `createMany` with
`skipDuplicates` on the unique column, exactly the trick `inbound_payments` uses with the
bank's `Message-ID`. LINE redelivers a webhook it did not get a 2xx for, so a redelivery
must be a no-op rather than a second row; a read-then-write would let two simultaneous
deliveries through the same gap. The write says whether the row was **new**, which is what
lets the alert below fire once for a message rather than once per delivery.

**The kind set is closed, with an `other` door.** A future LINE message type, and a text
message that arrived without its `text`, both land on `other` rather than on a refusal: a
webhook this system rejects is one LINE retries against a door nobody can open, and the
honest record of a malformed text is `other` with no body rather than a row that breaks
the CHECK or a throw that fails the whole delivery. `readLineMessageEvent` is pure, so
which types exist, what `other` catches, and the malformed-text case are unit tests.

A subject nobody holds is stored with a **null** `user_id` rather than dropped: a stranger
writing to the shop is a fact the shop may need.

### 4. The shop hears about a message once per window, not once per message

The recorded message queues a shop fact to the shop's own destination, and the fact is
**one per customer per ten-minute window**. The window is enforced by the database rather
than by a read: `notifications` gains a unique `(kind, dedupe_key)`, and the key is
`<subject>:<window index>`. Five messages in a burst produce five calls, one row, and the
other four report `duplicate`. Null keys stay distinct, so every row written before this
column existed is untouched by the constraint.

The window is a **duration** and not a calendar boundary, which is why it does not go
through `bangkok-time.ts`: a window that shifted with a time zone would make two shops on
two clocks disagree about how fast a person types. The number lives in `line-notify.ts`
because it is a decision about what the shop wants to hear, not about how a queue works.

**Why the shop hears at all**, given that LINE's own Official Account app already
notifies whoever holds its phone: those two alerts answer different questions. LINE's says
"somebody wrote to the shop"; this one says *which customer*, and a group is where the
counter can see it without one person's phone. A group push costs one message per member,
which is exactly why the dedupe is not optional: the alert arriving five times for five
messages is the version of this a shop mutes. The fact carries a snippet of a text message
or the kind of thing that arrived — never a reply, and never a code: ADR 0007's one hard
rule (the collection code does not go to the group) is untouched.

**Alternatives rejected.** One fact per message — the version a shop mutes, spending the
allowance at the rate a customer types. A read-then-write window check — two simultaneous
deliveries both win the read. And dropping the group alert entirely because LINE already
notifies the phone: that tells nobody *which* customer, and it tells nobody whose phone is
not the Official Account's.

### 5. Promotion consent is its own fact, with two timestamps

`line_promo_consent_at`, `line_promo_withdrawn_at` and a version of *its own* text
(`LINE_PROMO_CONSENT_VERSION`, separate from `LINE_CONSENT_VERSION`). **The later
timestamp wins**, a tie resolves to `withdrawn`, and the state is derived — so the case
that matters (agreed, withdrew, agreed again) is a pure unit test rather than a database
fixture. The three states are `never_asked`, `consented`, `withdrawn`, and `withdrawn` is
not `never_asked`: the card offers the act again, *named as one*
("ยินยอมรับโปรโมชันอีกครั้ง"), rather than re-asking somebody who already answered.

The first consent is not enough, and the reason is a purpose rather than a mood:
`line_consent_at` means "tell me my order is ready", granted by placing an order, and
nobody was promised a discount when they ordered. One version string covering both would
also make an audit row unable to say which sentence was shown.

The consent is offered as **its own act** on the LINE card — the account page and the LIFF
claim step — and never bundled into binding: binding is one act and promotions are
another, so the form sends the promotion choice as a **second request** after the sign-in
succeeds. A failure there does not block the sign-in, because a customer locked out by a
marketing checkbox would be a worse bug than a preference that can be set again on their
account. Withdrawal clears the promotion timestamps and touches neither the binding nor the
order notifications: the separation is the point.

The eligibility rule is one function, `linePromoConsentBlock`, used by both the campaign
and the card, so there is one place that knows what consent means. Its order is the
decision — `channel_not_line`, `not_bound`, `never_asked`, `withdrawn`, `not_a_friend` —
because the first reason is the one the screen says, and a customer who never agreed is
not somebody the shop should be reminding to add the shop as a friend.

### 6. A campaign reaches this deployment's own list, and the screen says what it costs

The audience is **consented *and* a friend**, read from this deployment's own rows. There
is no friend-count API, and `/broadcast` cannot honour a consent rule at all because it
takes no recipient list — it goes to every friend of the Official Account. So a campaign
is this deployment's own list, sent by **multicast**.

Recipients are split into batches of **at most 500** by a pure function
(`planCampaignBatches`), in the order given, with no empty tail — and the split is mirrored
by a CHECK on `line_campaign_batches.recipient_ids`, because a batch of 501 would be
refused by LINE *after* the shop had been told it was queued, which is the wrong order to
find out in. The recipient list is written into the batches **as it was at that moment**,
not recomputed at send time: a customer who withdraws tomorrow must not change what was
sent yesterday, and a batch re-derived from today's consent rows would be a different
message than the one the shop approved.

The composer reads `GET /v2/bot/message/quota` and `…/quota/consumption`, shows what the
campaign costs (**one message per recipient**, which is also what a group push costs per
member) and what the month has left, and refuses a send that cannot be paid for.
`type: 'none'` means **no limit** and is kept apart from "a number we could not read": the
first makes every send affordable, the second refuses the send rather than guessing, because
a guess in either direction is a lie to somebody about money's worth of allowance.
**LINE's refusal is the authority** — its documentation warns a send can be refused with
the monthly-limit error while the console still shows messages left, which is why the
refusal recorded on the batch is what a later reader trusts and this read only fills in a
number on a screen.

**One reader for the token, and it is not the channel's.** `NOTIFY_LINE_TOKEN` is read by
its own function, because it answers a different question from `NOTIFY_CHANNEL`: the
channel decides where the **shop's own alerts** go (a LINE group, an SMS gateway, nowhere
at all), while the token is what lets this deployment talk to LINE at all — which a
campaign needs, since a promotion goes to customers' LINE rather than to the shop's group.
A shop whose alerts go to a webhook can still send promotions on LINE; one that has turned
its own alerts off can too. `.env.example` says so, and the acceptance run configures
exactly that pair.

**Alternative rejected.** LINE's `/broadcast`, which is one request instead of a list and
would be simpler: it cannot say "consented customers only", so it would send a promotion to
every friend of the shop's account — including the ones who bound their LINE to collect an
order and never agreed to anything.

### 7. A campaign is sent once, by an admin, in the shop's own worker

`createCampaign` writes the campaign, its batches and the audit row in **one transaction**
(ADR 0007 decision 1) and **sends nothing**. The notify worker's second half claims due
batches and sends them. What the shop decided and what actually went out are two facts, and
a send that only existed in a log line could not answer "who got this promotion" afterwards.

**A batch is at most once.** It is claimed by a conditional update from `pending`, and a
failure is recorded **with LINE's own words** and left for an admin to decide about:
LINE's multicast takes no idempotency key, so a retry cannot be told apart from a fresh
send, and a promotion delivered twice to five hundred people is worse than one that needs a
person to press again. A batch left attempted with no outcome (a worker killed mid-send) is
abandoned after `CAMPAIGN_BATCH_STALL_MS` rather than retried, for the same reason. The
campaign's own status is derived from its batches, and **`partial` is a state the screen
must show** — some customers got it and some did not is the one case where somebody has to
decide whether to send again, and folding it into `sent` would hide it.

**Only an admin may send.** A campaign spends the month's allowance on every customer at
once and cannot be taken back, so it is not something done between two bills at the till.
Creation writes `line_campaign_sent` with the recipient count, the batch count, the first
words of the body and the quota the composer saw — a dispatch record rather than a copy of
the promotion, because the campaign row is where the whole text lives.

The door is **rate-limited** (ADR 0009 policy `line_campaign`, three per quarter hour) and
keyed by the **account** rather than the address, the way `member_create` is: three back to
back is an admin who mistyped and rewrote, and a fourth is a script spending somebody's
allowance.

### 8. The shop's screen, and the customer's card

`/admin/line` is the console: the composer with the audience and the cost, the campaign
history with each one's own words when LINE refused it, the messages the outbox could not
send, and the **requeue** button that finally calls `requeueNotification` — which has
existed with no caller since ADR 0007. It is admin-only, and the nav shows it to admins
through the same matrix every other page uses.

A customer's own messages appear on their card at `/admin/members`: the newest few beside
their points and orders, with a count on the list row, fetched in one grouped query rather
than per row. A short list, not a chat client — staff answer in LINE's own Official
Account app, and this system does not grow a second inbox.

**Out of scope, decided rather than forgotten:** a rich menu (its own effort: image
constraints, upload, per-user menus), Flex/template editing, storing image bytes (a photo
is a link, ADR 0014), scheduled sends, an in-app reply box, and the account card's
`window.location` bind press — a known gap in ADR 0030, waiting on a link-shaped `Button`
in the design system.

## Consequences

- A customer can open the shop from the shop's own message inside LINE and be signed in
  with the account they are already holding; the phone still proves the number, and the
  screens are the screens that already exist.
- `/line` joins the public surface, so the route inventory grows by one; it writes nothing
  without a LINE id token, and every path it can reach is counted.
- The webhook does more work per delivery — one insert, one notification plan, one name
  read — all after the signature check, all bounded by the burst window, and none of it on
  a redelivery that was already seen.
- A shop's LINE allowance is now spendable by this system on purpose, at one message per
  recipient. The composer says what a send will cost and what the month has left; LINE's own
  refusal is what a later reader trusts.
- The message log is more customer data on our hardware, riding the same unwritten PDPA
  posture as everything else (CONTEXT item 9), and it can now hold anything a customer chose
  to type.
- `npm run acceptance` section 21 walks the whole thing over real HTTP against stubs this
  run serves: a signed-in customer binds LINE from the account card, a signed `follow`
  webhook records the friend condition, a campaign to a customer who has only bound is
  refused for having nobody to reach, the consent makes the same send have an audience, a
  cashier is refused a send (403), the worker sends one multicast, a month with no allowance
  left refuses the send **without writing a campaign**, 501 recipients split into two
  batches, LINE's 429 leaves the campaign `partial` with LINE's own words on the batch, and
  a second pass sends nothing again.
- The entry's own decision is unit-tested (`tests/line-liff-entry.test.ts`), and the route
  it posts to is the one section 20 already drives.

## Known limits

- **The LIFF handshake cannot be exercised from this repository.** There is no LIFF browser
  here, so what is proven is the entry's *decision*, pure and unit-tested, plus the
  id-token route it posts to. The handshake itself is unmeasured, and this is the sentence
  that says so rather than a green run implying otherwise.
- **LINE's image-message size and format limits are unverified**, so no number is asserted
  anywhere: `originalContentUrl`/`previewImageUrl` are validated through
  `renderableImageUrl` (a link, ADR 0014) and LINE is what refuses an unacceptable one.
- **The quota arithmetic is a courtesy.** LINE's `429` is the authority, and a shop near
  its allowance will meet it.
- **A campaign cannot be scheduled, edited or cancelled**, and a failed batch is resent by
  sending a **new** campaign rather than by touching the old one. The old one keeps saying
  what happened, which is the point.
- **There is no reply composer**: staff answer in LINE's own Official Account app, and the
  messages are on the customer's card for context.
- The account card's *bind* press is still a `window.location` redirect — the known gap
  ADR 0030 §6 recorded, waiting on a link-shaped `Button`, and this ADR does not close it.

## Revisit when

- **A rich menu** is wanted: it is its own effort (image constraints, upload, per-user
  menus), and it re-uses everything here.
- A shop asks for **scheduled sends** or an in-app reply box, which would be the first
  reason this system has a message composer at all.
- The shop's LINE friends grow past what one multicast pass is comfortable with, or LINE
  changes the per-request cap.
- The **hosted build** arrives with more than one shop on a deployment: `LINE_LIFF_ID` is
  one value in the environment today and a LIFF app is registered per channel, so a
  per-shop LIFF id becomes a schema question rather than a configuration one.
- LINE publishes what an image message may actually be, at which point the validation can
  stop being a link check and the limits can be written down here.
