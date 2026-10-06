# Spec — LINE integration (ADR 0030)

**Status:** built in this round. Each section names the ticket that carried it.

## Problem

The shop talks to its staff on LINE, but the system cannot talk to *customers*
there: the only LINE address it holds is the shop's own group, and a phone number
is not a LINE user id (ADR 0007 decision 3, deliberately open). Customers who want
their "order ready" message on LINE — where they already are, all day — have no
door, and the owner hears about refunds and dismissed transfers only by opening
the dashboard.

## Decisions this spec implements

ADR 0030, five of them:

1. **LINE is a door, never an identity.** `line_subject` is a nullable unique
   column in the shape of `google_subject` (ADR 0020). Binding — the thing people
   call "syncing" — happens once, and the phone it anchors to is *proved* by an
   OTP, because a LINE callback can arrive in a browser holding somebody else's
   session and a typed number proves nothing (that is the takeover ADR 0020 §4
   refuses). Binding on an already-signed-in session needs no OTP: the session is
   the proof.
2. **Consent is two facts.** The customer's is a timestamp + version on their row
   (no "no" state — withdrawal clears subject and consent together). The shop's
   is the friend list (`line_friends`), written by the webhook, because LINE
   refuses a push to an unfollowed user *with a 200*, which would burn the
   outbox's retry schedule against a door nobody is behind.
3. **The shop's group keeps its job and gains two facts** — a refund, and an
   inbound transfer dismissed by hand — written in the same transaction as the
   act that made them true, deduped `(kind, order_id)` for the refund and
   `(kind, recipient)` for the dismissal (the recipient column carries the
   transfer's id when no order does).
4. **The webhook is one unauthenticated door**, signature-checked over the *raw
   body*, rate-limited (`line_webhook`), and answering 200 to everything signed —
   unconfigured, it is not a door.
5. **The id token is verified in process** (`line-id-token.ts`) against LINE's
   JWKS, pinned RS256, this channel id as audience — the exact shape
   `google-id-token.ts` established.

## The doors, as built

| Route | Auth | What it does |
| --- | --- | --- |
| `POST /api/v1/auth/line` | rate-limited, token verified | first half of sign-in: known subject → session; unknown → `needsPhone` |
| `POST /api/v1/auth/line/link` | rate-limited, token + OTP | second half: proves the phone, binds (existing row or new customer), consents, signs in |
| `GET /api/v1/auth/line/authorize` | signed state | starts the browser OAuth for the account page's bind button |
| `GET /api/v1/auth/line/callback` | state + token verified, session required | exchanges the code, binds to the session's row, redirects back to `/shop/account` |
| `POST /api/v1/account/line` | member session | bind (`{idToken}`), unbind (`{unlink:true}`), re-consent (`{consentOnly:true}`); `GET` reads the binding |
| `POST /api/v1/line/webhook` | HMAC signature + limiter | `follow` writes `line_friends`, `unfollow` clears it; everything else answered 200 and ignored |

Rate-limit policies added: `line_signin`, `line_link`, `line_webhook`
(`rate-limit-policy.ts` — the numbers live there and nowhere else).

## The messages, as built

- `line-notify.ts` is the planner for *audiences*: `lineCustomerNotifyBlock`
  names the one reason (not bound / no consent / not a friend / channel isn't
  LINE) a customer's code is not pushed, `planLineCustomerReadyMessage` plans the
  push to the customer's own subject only — the shop's group is never a fallback
  (ADR 0007 decision 3 kept, not reopened) — and the two shop-fact planners plan
  the refund and dismissal sentences.
- `markOrderReady` reads the customer's LINE facts beside their phone and
  enqueues through the same outbox; on a LINE channel the webhook planner plans
  nothing (it answers null there), so exactly one customer message exists per
  order.
- `refundOrder` and `dismissInboundTransfer` enqueue their fact inside the
  transaction that writes the audit row.

## What the customer sees

`/shop/account` gains a LINE tab (`LinePanel` in `AccountPortal.tsx`): masked
subject when bound, consent state with the friend reminder in the same card, the
OAuth bind button, and withdrawal as one act. The page reads the binding through
`lineBindingForUser` — what is shown is true now, not what the session claimed
when minted.

## Environment (all optional; unset = the feature is off)

`LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET`, `LINE_MESSAGING_CHANNEL_SECRET`
(may be the same channel), `NOTIFY_LINE_TOKEN` (already existed), optional
`LINE_JWKS_URL` override for the acceptance run. `scripts/line-wizard.ts` walks a
human through provisioning and writes them.

## Deliberately not built

Rich menu, broadcast, template editing, LIFF (the in-LINE browser works against
the normal pages today), auto-answering customer messages (the Official
Account's own setting covers it), merging accounts by email.
