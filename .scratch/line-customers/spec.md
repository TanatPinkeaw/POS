# Spec — Customers in LINE, both directions (ADR 0032)

**Status:** ready-for-agent. Grilled in one session (25 decisions, all settled) and
ticketed under `.scratch/line-customers/issues/`.

Authoritative criteria that do not change here: [ADR 0030](../../docs/adr/0030-a-customer-is-reached-on-line.md)
(the door, the binding, the two consents, the webhook) and
[ADR 0007](../../docs/adr/0007-the-shop-sends-its-own-notifications.md) (the outbox).
This effort adds the three things ADR 0030 named as *known limits*: the LIFF surface,
broadcast, and answering a customer.

## Problem

The door works: a customer can sign in with LINE, bind by OTP, consent, and receive
their collection code on their own LINE. Three things are still missing, and each one
is a fact about today's code:

- **The in-LINE surface does not exist.** ADR 0030 §6 built a redirect flow that
  finishes in the customer's own browser. Inside LINE the customer can open the
  ordinary pages and sign in through that flow, but there is no entry that takes the
  LINE account they are already holding and hands them a session in one tap.
- **A customer's message is thrown away.** The webhook receives `message` events and
  records nothing (`src/app/api/v1/line/webhook/route.ts`), so the one channel the
  shop's customers actually use carries no history this system can read.
- **The shop can only send one customer at a time, and only about an order.** Every
  message the outbox can produce is tied to an order or a bank transfer. There is no
  way to tell the customers who said yes that the shop has something to say.

## Facts this spec is built on (measured, not remembered)

From LINE's own documentation, read during the grilling:

- Reply messages are free; **push, multicast and broadcast are counted per recipient**
  against the monthly allowance. Thailand's free plan is **300 messages/month**. Over
  the allowance LINE answers **429 `You have reached your monthly limit.`** — and its
  docs warn the same error can arrive while the console still shows messages left.
- **A push to a group counts once per member of that group**, not once per group. Every
  existing shop fact therefore costs as many messages as the group has members.
- `GET /v2/bot/message/quota` returns `{type, value}`; `GET …/quota/consumption`
  returns `{totalUsage}`. There is **no live friend-count API** (only a date-based
  insight endpoint with unverifiable eligibility), so the number of recipients a
  campaign will reach must come from this deployment's own rows.
- `POST /v2/bot/message/multicast` accepts **at most 500 user IDs per request**
  (200 requests/second). `/broadcast` goes to every friend of the Official Account and
  accepts **no recipient list** — it cannot honour this shop's consent rule.
- A LIFF app is registered **inside the existing LINE Login channel** and gets a
  `liffId`. Its endpoint URL must be **HTTPS** and may be a route of this deployment.
  `liff.getIDToken()` returns a token signed **ES256 with the channel id as audience**
  — the exact shape `src/lib/line-id-token.ts` already verifies for the SDK path.
  The SDK is available as the npm package `@line/liff` (bundle it; then the script is
  same-origin and no CSP change is needed) or from LINE's CDN.
- A LINE Login `sub` and a Messaging API `userId` are **the same value for the same
  person when both channels sit under one provider** — which is what lets a webhook
  event be matched to a customer row by `line_subject`.
- An image message carries `originalContentUrl` and `previewImageUrl`, both HTTPS with
  TLS 1.2+. **The exact size and format limits could not be confirmed from primary
  sources**, so no number is written into this repository; the implementation confirms
  them before it refuses anything by size.

## Decisions (settled in the grilling; the ADR carries the reasoning)

1. LIFF is a **door**, not an identity: the phone stays the identity and the id token
   path is the one ADR 0030 already built.
2. `/line` is a **public route** and is the LIFF endpoint URL. It signs in and hands
   the customer to the ordinary `/shop/*` screens rather than re-implementing them.
3. The SDK is the **npm package, bundled**, so the script is same-origin.
4. In an external browser `/line` says to open it from the LINE app and offers the
   ordinary doors at `/login`.
5. The order-ready message **carries the LIFF link**.
6. A first sign-in through LIFF collects the phone **inside the LIFF page**, using the
   `idToken` path `POST /api/v1/auth/line/link` already accepts. The OTP stays: it
   proves the number, which is what §1 of ADR 0030 needs.
7. A customer's message is **recorded** (`line_messages`), deduped on **LINE's own
   message id** — the trick `inbound_payments` uses with the bank's `Message-ID`. Text
   is stored; any other kind stores its kind and no bytes (this deployment holds no
   files).
8. The message is **surfaced twice**: a shop fact to the shop's group, and the recent
   messages on that customer's card at `/admin/members`. Staff answer in LINE's own
   Official Account app — this system does not grow a chat client.
9. A burst from one customer produces **one group fact per quiet window**, not one per
   message: LINE's own app already alerts staff, and a group push costs one message per
   member.
10. Promotion consent is **its own fact**, not the notification consent: an
    acknowledged timestamp and a withdrawn timestamp, latest wins. It is offered as its
    own act on the LINE card (account page and LIFF), never bundled into binding.
11. A campaign reaches **this deployment's own list** — consented **and** a friend —
    in batches of at most 500 through **multicast**, never LINE's `/broadcast`.
12. The composer shows the **cost and the month's remainder** (read from LINE's quota
    endpoints) and refuses a send that cannot be paid for; LINE's 429 remains the
    authority and is recorded as the campaign's own failure reason.
13. A campaign batch is **at-most-once**. A failed batch is recorded and left for an
    admin to resend; LINE offers no idempotency key, and a duplicated promotion is
    worse than a short one.
14. Only an **admin** sends, with an audit row. Standard order: **no fields** —
    a campaign is sent the moment it is written.
15. Content is **text plus an optional image link**, validated through
    `renderableImageUrl`/`probeImageUrl` (`src/lib/image-url.ts`) when it is saved.
16. A `/admin/line` screen carries the composer, the campaign history, the messages
    that could not be sent — and the **requeue** button that finally calls
    `requeueNotification`, which has existed with no caller since ADR 0007.

## Out of scope (decided, not forgotten)

Rich menu (its own effort: image constraints, upload, per-user menus), Flex/template
editing, storing image bytes (a photo stays a link, ADR 0014), scheduled sends, an
in-app reply box, and the account card's `window.location` bind press — a known gap in
ADR 0030, waiting on a link-shaped `Button` in the design system.

## Test seams

Pure modules with no I/O, each tested without a server: `line-liff-entry.ts` (what the
entry decides from the query, the session state and the configuration),
`line-promo-consent.ts` (which of the two timestamps wins), `line-campaign-rules.ts`
(who is eligible, how the batches split, what a send costs). Persistence modules
tested against real PostgreSQL: `line-messages.ts` (one row per LINE message however
often it is redelivered), `line-campaigns.ts` (a campaign and its batches), and the
outbox's new `dedupe_key` (one group fact per customer per window). The quota reader
(`line-quota.ts`) is tested against a stub base URL, the way the acceptance run
already stubs LINE's token endpoint with `LINE_TOKEN_URL`.

## Delivery

Tickets are worked blockers-first as red/green slices, then reviewed on the Standards
and Spec axes, and the documents named in ticket 09 change in the same commits. The
one limitation that stays open is stated where it belongs: the LIFF handshake itself
cannot be exercised from this repository (there is no LIFF browser), so what is proven
is the entry's own decision plus the id-token route it calls.
