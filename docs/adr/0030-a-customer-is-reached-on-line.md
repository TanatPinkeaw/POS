# ADR 0030 — A customer is reached on LINE, by consent, on their own address

**Status:** accepted (2026-10-06). **Amends ADR 0007 decision 3** — the one it left
open on purpose — and follows the shape ADR 0020 built for Google. **Depends on
ADR 0029**: the front door is `/login`, and the LINE door opens beside the other two.

**Context.** ADR 0007 built the outbox and the LINE transport, and refused to put a
customer's collection code through the channel: the only LINE address the shop had
was its own staff group, and a phone number is not a LINE user id. That refusal is
what made the channel honest instead of dangerous. The ask now is the whole thing it
was waiting for: customers on LINE — signed in with it, notified on it, with the
shop's own group kept for facts about orders. A LINE Login channel and a Messaging
API channel are two channels in LINE's console, and the deployment already has a
tunnel, so both doors and the webhook are reachable without new infrastructure.

## Decisions

### 1. LINE is a door, never an identity — and linking happens once, by OTP

The phone stays the identity, exactly as it does under Google (ADR 0020 §2). One
`users` row, many doors; `line_subject` is a nullable unique column like
`google_subject`, and the "sync" a person might call joining two accounts is really
**binding**: a LINE credential that resolves to no row collects a phone, an OTP code
sent to *that* number is consumed (`otp-store.ts`, the same challenge the phone
change uses), and only then does the row learn the subject.

The proof is demanded here and not for Google for one measured reason: a LINE
callback can arrive in a browser whose session cookie says somebody else, and
binding on the strength of the callback alone would be the takeover ADR 0020 §4
exists to refuse. The code proves the number is held *right now*, which is what the
binding act needs and what a typed number never proved. A returning customer whose
subject already resolves signs straight in; a number that belongs to staff or to
another customer is refused in the same words the Google door uses.

A new customer made by this door keeps ADR 0020's shape — random password hash,
notice acknowledged, `member_created` audited — and gains one audit row of its own:
`line_bound`, with the version of the LINE consent text acknowledged.

### 2. Notification is consented twice, and unfollowed is heard

Consent is not a boolean the app invents; it is two facts, recorded:

- **The customer's**: `line_notify_consent` — a nullable timestamp, not a flag. Null
  is "never asked", and "no" is never written: withdrawing clears the subject and
  the timestamp together, which is the strongest form of "stop messaging me" and
  also the easiest to explain to the person who asked. The consent text is
  versioned like the privacy notice, and the version acknowledged rides the audit
  row.
- **The shop's**: a LINE push is delivered only to somebody who is a friend of the
  Official Account — an unfollowed user's push is refused with a 200, so the outbox
  would burn its whole retry schedule against a door nobody is behind. The follow
  webhook writes a row in `line_friends`; the planner plans only for a subject that
  is a friend *and* has consented.

Both are re-checkable facts rather than assumptions, and the unfollow event clears
the friend row rather than the consent: coming back as a friend is one tap, and
the customer should not have to walk the consent screen again for it.

### 3. The shop's own group keeps its job, and gains two facts

ADR 0007's rule stands unchanged: **the shop's group gets facts about orders; the
customer's LINE gets the code.** What is added is the two facts the owner today
learns by finding out late — a bill was refunded, and a bank notification was
dismissed by hand. Both are written in the same transaction as the act that made
them true (ADR 0007 decision 1), through a *shop-fact* planner that is separate
from the customer planner because it answers a different question — "does the
counter need to hear this" rather than "does this customer need to be told" — and
because its dedupe key rides the audit trail's target rather than an order.

Shop facts are recorded even when the queue is empty of customer messages: the
dedupe is `(kind, order_id)` for the refund and `(kind, recipient)` for the
dismissal, and an unconfigurable queue leaves nothing anywhere — the same "unset
means nothing is queued" as before.

### 4. The webhook is one unauthenticated door, signature-checked and limited

LINE's servers POST `follow`, `unfollow` and `message` events to
`/api/v1/line/webhook` with an `x-line-signature` HMAC of the raw body under the
channel secret. The body is read as text first — verifying the transformed body is
the classic way this door fails — and the signature is checked in process with
`node:crypto`'s HMAC and `timingSafeEqual`. It is deliberately **not** `jose`,
which this repository reaches for everywhere else: jose speaks JWS, and LINE's
signature is not a JWS — it is a bare HMAC over the body with no header and no
payload framing, and forcing it into a JWS-shaped envelope to keep one import
would be ceremony. Rate-limited per address (ADR 0009 policy
`line_webhook`), because an unauthenticated door that writes rows is a row-filler's
door otherwise.

### 5. The verifier is in-process, against LINE's JWKS

`line-id-token.ts` verifies the LINE Login id token the same way
`google-id-token.ts` verifies Google's: `jose`, pinned algorithm (RS256), this
deployment's channel id as audience, LINE's issuers, and a JWKS URL the operator
may override for the acceptance run. The subject it returns is what lands on
`users.line_subject`. The email in the token is stored, never trusted for linking —
the takeover guard is the OTP, not an address somebody else may also hold.

### 6. The browser flow signs in as well as binds — one door, one promise (amended)

**What was decided first, and what it did.** Decision 1 built two ways in: an id-token door
for a browser that holds one, and the OAuth redirect flow for everyone else. Only the
redirect flow was wired to a screen, and the screen it was wired to was the account page's
"ผูกบัญชี LINE" button. The front door's own button (`/login`) pointed at the same route, so
it minted a **binding** state — and the callback requires a signed-in member for a binding,
which an anonymous visitor has not got. The customer walked to LINE, consented, came back
and was handed to `/shop/account`, which needs the session they had just failed to obtain
and therefore bounced them to `/login`. The button promised a sign-in and delivered a loop.
Worse, the refusal was *silent*: the account card read `?line=` and threw it away, so from
the customer's side nothing had happened at all.

**The rule now: one door, one promise.** The intent is decided by `line-door.ts` — pure, and
tested against the loop itself — and travels *inside* the state's signature, so a customer
cannot edit which door they are at:

- **`/login` signs in**, and says so out loud (`?intent=sign-in`). It never writes a
  binding, even when the browser happens to hold somebody's session: a shared tablet must
  not turn one person's sign-in press into a write on another person's account.
- **`/shop/account` binds**, also out loud (`?intent=bind`). Its press is a binding act
  against the session that is already there, which is why it uses the same consent screen
  and no OTP.
- **A bare `/authorize`** (a bookmark, a printed QR, a link pasted into a chat) falls back to
the session: no session means sign-in. That is the belt to the explicit braces — no URL a
customer can reach loops them back to where they started.

**The half that needed a new mechanism.** ADR 0030 §1 already decided that a LINE account
nobody holds must *prove a phone* before it is attached, and answered that with an OTP. But
the redirect flow's id token never reaches the browser — LINE sends our callback a code and
the token comes back to the server — so the customer's own browser had no way to present the
proof that the `link` route demanded, and a first sign-in through the front door was
impossible in principle, not merely unbuilt. So the callback hands its verified answer back
to the browser that completed the consent: a signed, httpOnly, `SameSite=Lax` cookie
(`line-pending.ts`), ten minutes long, naming a **LINE subject and profile** rather than a
session. `POST /api/v1/auth/line/link` now accepts either of two proofs — that handoff, or an
`idToken` from the in-LINE surface — and clears the handoff when it succeeds, so it cannot
be replayed with a different number. The order is fixed rather than either/or: an id token
wins when the caller sent one, and the cookie is what answers a browser that has none. A
browser can honestly hold both (a handoff from an abandoned press, an id token from a later
one), and refusing that pair would fail a customer for something they cannot see, which is
the rule the whole door follows — the proof must be the one that was actually verified, not
the only one that happens to exist.

**Alternatives rejected, and why.** The id token itself in a cookie: a full credential in a
browser, when the only thing needed is "which LINE account was verified here". A pending
identity on the server: a new table for a fact that lives for ten minutes and whose owner is
one browser. The subject in the URL: it lands in history and referrers, which is the opposite
of the httpOnly property that makes the cookie acceptable. And making the OTP door a
sign-in door of its own (prove a number, get a session, then bind): that would have been a
*new* way to become a customer, when the rule this ADR already states is that the LINE proof
and the phone proof must both be present at the write.

**What the customer sees now.** An unbound LINE account lands on `/login?line=claim` — the
same fact the account page needs (a phone, a code, the notice) collected on the screen that
can render it — and every other outcome lands on a page that can *say* it: `session`,
`inactive`, `staff`, `error` on `/login`, `bound`, `taken`, `error` on the account card. The
silent bounce is gone in both directions.

**Where the id token is exchanged is now an operator's variable.** `LINE_TOKEN_URL` joins
`LINE_JWKS_URL` for the reason that one already carries: the acceptance run points it at a
listener it serves itself, so the whole flow — mint the state, walk the callback, exchange
the code, verify the id token, start the session — is exercised without a live LINE. The
trade is the same and is stated: whoever sets it moves where this server sends the shop's
channel secret, so it is set from the same `.env` that already holds the secret.

**The callback is the one door here that was missing from the limiter.** Every other
door in this feature counts attempts (ADR 0009 policies `line_signin`, `line_link`,
`line_webhook`), and this one earns its place more than most: past the state check it makes
an *outbound* request to LINE on the shop's channel secret, and on the sign-in path it mints
a session. The state is a bearer value, so "we minted it" bounds who can reach that work but
not how often — hence ADR 0009 policy `line_callback`, twenty per quarter hour per address,
which a customer pressing the button twice and reloading never reaches. It is charged once
the state verifies and before the outbound request, not after a refusal, because here the
work is the thing being counted.

## Consequences

- A shop that configures both channels gets the full picture: customers sign in
  with LINE, are told their order is ready on their own LINE, and the counter's
  group hears about refunds and dismissed transfers without anybody watching a
  screen.
- The unauthenticated door count rises by two (webhook, link callback), and both
  are limited and write nothing without a credential or a signature.
- PDPA grows again: a LINE subject is one more identifier on our hardware, riding
  the same unwritten posture as everything else (CONTEXT item 9).
- Both directions of the front door are now exercised end to end by `npm run
  acceptance` (section 20): the authorize route mints a state, the callback is walked the
  way LINE's redirect walks it, the code is exchanged against a token endpoint the run
  serves, the id token is verified against a key set the run serves, and the customer ends
  up signed in — plus the two refusals (a binding with no session, a state we did not
  mint).
- Known limits: no rich menu, no broadcast, no template editing from the UI. The Mini App
  (LIFF) remains the next decision rather than this one — but the browser flow now signs a
  customer in *and* finishes a first sign-in, so LIFF is a nicer surface rather than the
  only way to complete one.
- A LINE push costs nothing per message but can be refused at LINE's side; delivery
  receipts remain unread (ADR 0007's limitation, unchanged).

## Revisit when

- A shop wants the LIFF app — that is a UI decision about the in-LINE surface and
  re-uses every binding here.
- A customer messages the Official Account and the shop wants replies routed to a
  person rather than answered by the auto-response text.
- The friend list grows to the point where syncing it on demand beats listening to
  the webhook.
