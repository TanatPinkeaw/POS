# ADR 0005 — Confirming a transfer automatically, without a payment provider

**Status:** accepted (2026-09-28)
**Context:** ADR 0002 gave the shop a PromptPay QR locked to one amount, and the
confirmation endpoint already accepted a machine holding a shared secret. What was
missing was anything to put on the other end of it. The obvious answer is a payment
provider or a bank API; both charge per check or per month, and both need the shop
to sign up for something before a single transfer can close a single bill.

## Decisions

### 1. The shop's own bank notification is the source of truth

Thai banks email the account holder when money arrives. The shop already has that
mailbox and already pays for it, so the missing piece is a script, not a
subscription: `scripts/bank-bridge.ts` logs into the mailbox over IMAP, reads the
unseen notifications, and posts each one to `POST /api/v1/payments/inbound`.

Rejected: a payment provider (costs money per check, and the shop's money flows
through a third party's account model), a bank API (needs business onboarding and,
at the time of writing, is not offered to small merchants by the banks this shop
uses), and "the cashier looks at the banking app" (which is what already happened
and is the thing being improved — it stays as the fallback, with a supervisor PIN).

The cost of this decision is honest and worth stating: the bridge is a script the
shop has to keep running, it speaks only implicit TLS on port 993, it does not
handle OAuth, and its amount pattern is configured per bank. A shop that would
rather run its own bridge, or a provider that posts the same JSON, needs nothing
from us at all — the endpoint does not care who calls it.

Because it reads a *mailbox* rather than a bank API, one more rule is needed:
only mail from the bank counts. `BANK_NOTIFICATION_FROM` filters on the From
header, and messages that do not match are marked read and left alone. Without it
every unread newsletter in a shared mailbox would be filed as money whose amount
could not be read, which is the one screen that must stay trustworthy.

### 2. A notification is recorded first, and matched second

`inbound_payments` holds every notification, matched or not. The row is written
with the outcome *and* the reason it could not be attributed, so money that arrives
cannot be lost by the system failing to understand it. The dashboard shows what is
still unattributed, and an admin can close it with a reason.

This is the decision that makes the automatic path safe to switch on. The failure
mode of "record nothing you cannot match" is a shop whose bank balance and till
balance disagree with no way to find out why; the failure mode of "record
everything" is a screen with a to-do on it.

### 3. The matcher never guesses

`src/lib/inbound-match.ts` is pure and decides in one place. It requires the
*amount* to match a QR exactly, in satang, and then requires the notification to
name that QR's reference as a token. An amount on its own is refused even when
exactly one QR is open, because "there was only one" is a fact about the moment
rather than about the transfer, and two customers in one queue can owe the same
107.00. Refusals are typed — `amount_unreadable`, `no_amount_match`,
`no_reference`, `ambiguous`, `not_payable` — because each one is a different
sentence to the person who has to sort it out.

Payability is judged against the instant the *bank* says the money moved, not the
moment the bridge got round to posting, and against the same inequality the
database uses (`expires_at > receivedAt`): a notification delayed in a mailbox was
still a payment made inside the window.

### 4. One message is recorded once, by the database

`UNIQUE (source, external_id)` where `external_id` is the bank's own `Message-ID`,
falling back to the mailbox UID. A bridge that retries is the normal case rather
than the exception — it is a shell script that may be killed at any point — and the
guarantee belongs in the schema rather than in the script's bookkeeping.

### 5. Money can be recorded without an amount, and that is not a zero

`inbound_payments.amount` is nullable, and a CHECK ties the null to exactly one
reason: the amount was unreadable. A bridge that cannot parse a bank's wording
posts the text it has rather than dropping the notification, and the record shows
no figure rather than a fabricated one. Writing a zero or a satang placeholder was
the alternative and was rejected: a made-up number in a money column is the one
thing this table must never contain.

### 6. Dismissing a transfer needs a reason, but not a PIN

An admin may close an unattributed transfer as "not a sale of ours", with a reason,
audited as `inbound_transfer_dismissed`. No supervisor PIN, unlike a refund or a
manual confirmation, because this moves no money: the transfer stays in the bank
account exactly where it was, and all that changes is that the system stops asking.
The reason is required because the alternative to a written-off transfer is a
conversation with the shop's bank, and whoever has that conversation needs to know
what was decided and by whom.

### 7. Refunds are not automated, in either direction

There is no inbound counterpart for money going *out*. Reversing a paid sale hands
cash back from the open drawer or is done by hand in the shop's banking app, and
the credit note records which (ADR 0004). Pushing money out automatically needs
bank API onboarding and an authority this system should not hold: a bug in a
matcher that closes a bill is a bill closed wrongly, while a bug in a matcher that
pays out is money gone.

## Consequences

- A shop with a mailbox and an always-on machine gets bills closing themselves,
  for nothing, and can see exactly which transfers did not.
- The bridge is the part most likely to need editing for a given bank, which is
  why everything about reading mail is pure, in `src/lib/bank-mail.ts`, and tested
  against messages shaped like real ones.
- The dashboard grows a card that only appears when it has something to say. If it
  ever appears routinely, the amount pattern is wrong and is worth fixing.
- Known limits, stated rather than discovered: no STARTTLS, no OAuth, no
  attachments, and no `windows-874` charset decoding (see `bank-mail.ts` for why
  ASCII is enough for the two fields that matter).
- A notification the shop's pattern cannot read is *posted*, not skipped: it
  appears on the dashboard as an unreadable amount, which is the signal that the
  pattern needs fixing. Only mail that is not from the bank is skipped.

## Revisit when

- A bank the shop uses stops sending notification email, or moves to a push API.
- A second source of notifications appears (a provider, a second bank account).
  The `source` column exists for that; the unique index is per source already.
- Partial or per-line refunds land. If a refund can be partial, the question of
  whether an *outbound* transfer may be confirmed by a bank notification arrives
  with it, and decision 7 has to be argued again rather than inherited.
