# ADR 0025 — A member offers goods on their own account, and its documents ride with the product

**Status:** accepted (2026-10-04)
**Context:** ADR 0023 built consignment: products a member owns, a share of the net the
shop owes, a ledger, payouts, and a portal where the member reads their own position.
Every way into it assumed the shop already had the goods — the owner created a product
by hand, found the member, typed the share, and set the stock.

That assumption is wrong for the case this repository's shop actually has. A member who
makes things at home brings a tray of them to the counter. Filling that in by hand is
one screen per item, at the counter, while a person waits — and the first member who
has ten items discovers that it does not scale, and stops consigning. The owner asked
for a way to *see the goods first*, which is the one thing a hand-typed row cannot do.

The request was specific: a file-upload screen for warehouse stock, available to
members, whose answers update the consignment data, with the documents staying attached
to that product, and **without a new tab**.

**Superseded in part during drafting.** The screen was first built as a **Google Form**
with an Apps Script trigger posting into this system. That was rejected: it put a
third-party web page between the member and the shop's own record, asked for a phone
number the member had already given the shop at sign-up, and required the shop to build
and maintain a form artefact in a second account. The screen belongs in the member's own
account page, where the member is already signed in. What survived the change and is
decided below is the *shape* of the offer — the part that was never about Google.

## Decisions

### 1. The member's own account page is the intake

There is no second system and no shop configuration. The offer form is a panel inside
the **existing ฝากขาย tab** on `/shop/account`, above the member's balance, and it posts
to `POST /api/v1/consignment/submissions`. No new tab, no new route, no link to leave
the site and come back.

The rejected alternative is an upload form rendered by this application. It would need
storage, size and type limits, a place to put bytes, and a backup that covers them — the
list README's *Not built yet* has carried deliberately since ADR 0014, and one round of
consignment offers is not the evidence that changes it.

### 2. An offer is not an arrangement

The intake creates **no product, no share and no stock movement**. It writes a pending
row. An owner approving one is what calls the *existing* `setConsignment` — the same rule
that has always guarded the share, in the same transaction that creates the product and
`adjustStock`s the shelf.

The share is the reason this door is admin-only. A member offering goods has not agreed
a percentage with anybody, so the member's form cannot supply one and must not be able
to.

### 3. The owner is the session, and only the session

`consignor_user_id` is **NOT NULL** and comes from the session. There is no phone
field, no member-id field, and no `matched: false` case: a signed-in member is somebody
specific, so the whole failure mode of "a phone number that matched no account" cannot
occur and has nothing to guard against.

The owner's inbox reads the member's name and number from their **account** rather than
copying them onto the offer, so a member who corrects a phone number is reachable under
the new one without editing history. An owner can still pass `consignorUserId` at
approval, because the person standing at the counter is not always the member whose
account carries the ledger.

### 4. The links are kept, the bytes are not

`consignment_documents.url` is a link, for the reason ADR 0014 gives for product photos:
this deployment holds no files it could back up or vouch for. A member's photographs
live where they live.

A Drive **file** link (`/file/d/<id>/view`) is not an image URL, so the owner may find a
photo row it cannot draw. `drawable` in the view is the same `renderableImageUrl`
allowlist an operator's pasted link goes through, and a row that fails it is drawn as a
link that opens it. The first usable photo becomes the product's image at approval.

### 5. `client_ref` is unique, because a member on a phone double-taps

The browser mints one UUID per filled form (`crypto.randomUUID`, the same idea as
`orders.client_ref` in ADR 0019). It is UNIQUE in the database and the lookup happens
**before** the insert, so a second tap or a retried request is answered with the offer
already recorded — 200 rather than 201 — instead of a second row of the same goods in an
owner's inbox.

The row behind a key that has already been *decided* is closed, and replaying the key
does not resurrect it. A member who wants to try again sends a new offer with a new key.

### 6. A refusal needs a reason, and deletes nothing

The note is required and the row is kept. A member reads the reason on their own account
page, which is the same tab they sent it from — a refusal with no stated cause is one
they answer by sending the same goods again. The audit trail keeps "how many offers does
this shop decline, and why" as a question with an answer.

### 7. The rate limit is keyed by the account

`consignment_offer` is ten back to back, then one a minute, scoped by the session's id
rather than the socket address — the same reasoning as `member_create`: two members on
the shop's one wifi are two people, and neither should spend the other's budget.

It exists because what it makes is durable and an owner has to work through it. Somebody
offering a tray of things pauses to photograph it and to type, so the ceiling is
invisible to a person and stops a script that has mistaken a retry loop for an offer.

## Consequences

* A member offers goods from the page they already have open, and reads the outcome in
  the same tab. Nothing about the offer exists outside this system.
* The owner's inbox at the top of `/admin/consignors` is unchanged in shape: it gains
  rows from a member rather than from a script, and each row names a person.
* There is no shop setting for consignment. Whether the shop takes goods on is decided
  per offer, by an owner, as it always was.
* The customer notice names one new collection point and **no new third party**, which is
  why `CUSTOMER_NOTICE_EFFECTIVE_FROM` moved to 2026-10-04: the words a member
  acknowledges changed, so every earlier acknowledgement would otherwise point at text
  nobody read.

## Known gaps

* **No upload.** A member must already have the photograph somewhere with a link. On a
  phone that means uploading to Drive or Photos first. This is ADR 0014 applied, not an
  oversight, but it is the shape of the friction a member will feel.
* **Links can rot.** Nothing here can tell a live URL from a dead one, so a member whose
  photo host goes away leaves an owner with a row and no picture. `drawable` only says the
  URL *shape* is drawable, not that anything is behind it.
* **No notification.** A member who sends an offer finds out it was approved by opening
  the same tab again; the notification outbox (ADR 0007) has no channel wired for this.
* **The approval dialog cannot pick a consignor.** The API accepts `consignorUserId` and
  `approveSubmission` honours it, but the dialog has no member picker, so the override is
  reachable only over the API.
