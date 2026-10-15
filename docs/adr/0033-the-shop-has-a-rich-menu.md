# ADR 0033 — The shop has a rich menu, and this repository does not own it

**Status:** accepted (2026-10-15). **Amends ADR 0032 §8**, whose *out of scope* named the
rich menu as "its own effort: image constraints, upload, per-user menus". This ADR is the
first half of that effort and says plainly which half: a menu **exists on the shop's
Official Account**, and no part of this deployment knows it does.

**Context.** ADR 0032 left the rich menu out on purpose. What is left in a customer's hand
after it is the thing it left undone: a friend of the shop opens the chat and sees no way
into the catalogue, the orders or their own account, so the three screens a customer returns
to are reachable only by typing a URL or following a message that happens to carry one. A
rich menu is LINE's own object for that — an image with rectangular tap areas under the chat.

**This is a manual act recorded, not a feature built.** The menu was created by calling the
Messaging API once
(`POST /v2/bot/richmenu` → `POST /v2/bot/richmenu/{id}/content` → `POST /v2/bot/user/all/richmenu/{id}`),
from a script that lives outside this repository. Nothing below is a claim that the app can
do it.

## Decisions

### 1. Three doors, one per customer screen — and never the till or the back office

| Button | Action | Where it goes |
| --- | --- | --- |
| สินค้า | `uri` | `/shop/products` |
| ออเดอร์ของฉัน | `uri` | `/shop/orders` |
| บัญชีของฉัน | `uri` | `/shop/account` |

These are the three screens a customer comes back to. A rich menu is shown to **every friend
of the Official Account**, which includes customers, employees and whoever walked past the
counter, so a button is a door anybody may press: `/pos` and `/admin` are gated by
`requireShellUser` and would have answered with a redirect to `/login`, which is a door a
customer can see and cannot open. Picking the customer's own three screens is what makes the
menu honest about who is looking at it.

### 2. Plain `uri` actions, not LIFF deep links

A LIFF link to `/line` would sign the customer in on arrival instead of landing them on a
sign-in page. It is the better door and it is **not** what was done, for two reasons that are
measurements rather than caution: `LINE_LIFF_ID` is unset in this deployment, so there is no
entry to link to, and a LIFF link makes the menu depend on **LINE's own app handoff** — the
one leg ADR 0032 §9 records as unmeasurable here, because no browser in this repository is
LINE. A plain `uri` opens in LINE's in-app browser, in any browser, and needs no LIFF app.

**Rejected:** LIFF deep links now. This is the decision to revisit first once the LIFF app
exists and a phone has proven the handoff.

### 3. The tap areas are the artwork's own thirds, measured from its pixels

The image is 2500×843 and its drawn dividers sit at **x = 832..833** and **x = 1666..1667**.
The areas are therefore `0+834`, `834+833`, `1667+833` across the full 843 height — the full
height even though the drawn lines stop short of the top and bottom edges, because a tap near
the edge of a button belongs to that button and not to the gap beside it. Areas guessed from
looking at the picture put a dead strip beside every line, which reads as a button that
sometimes ignores you.

### 4. One image size, and the deployment does not choose it

2500×843 is the widest of the sizes LINE accepts. Anything else is refused by LINE or scaled
by it into someone else's geometry, so the artwork is drawn to this size rather than the size
being talked about in the runbook as a preference. The file that is live is **60,321 bytes of
JPEG** and it is byte-identical to what was uploaded — verified by fetching
`/v2/bot/richmenu/{id}/content` back and comparing it, because an image LINE accepted is not
the same claim as an image LINE holds unchanged.

### 5. The menu is an operator's act, and this deployment stores nothing about it

No row, no environment value, no screen. The live menu id is
`richmenu-0bdd3801037ec38bf01c96a13353e0db`, which exists in LINE's API and in this document —
and nowhere else. **That is the cost of this decision and it is deliberate:** the alternative
was a `line:richmenu` command plus an admin screen, which is the *second* half of ADR 0032's
own effort (upload, image handling, per-user menus) and is not something to bolt on while
answering "can a customer reach the catalogue from the chat".

**Consequences that follow, and that a later round must not be surprised by:** the id is
**per channel**, so re-creating the Official Account or its Messaging API channel mints a new
one and orphans this record; `npm run backup` does not cover the menu, because what it dumps
is the shop's database and the menu is LINE's object; and a fresh deployment starts with no
menu at all.

### 6. Thai strings never pass through a command line

The menu's name (`เมนูลูกค้า เหลี่ยมนอก`) and its bar text (`เมนู`) are built in the request
body from a UTF-8 file. Passing them as shell arguments on Windows re-encodes them to `?` —
the trap AGENTS.md records — and a menu whose name silently became question marks is a defect
that only a person looking at a phone finds. The same rule as every Thai string this system
writes.

## Consequences

- A friend of the shop opens the chat and has three named doors. Nothing in this deployment
  changed to make that true, so nothing else can have broken because of it.
- **Git does not know the menu exists.** There is no diff, no test and no gate that would
  notice the menu going away, and no command that would bring it back. This document is the
  only place the id is written down.
- Nothing new is on this hardware: a rich menu is LINE's object, not a row, so the PDPA
  posture (CONTEXT item 9) is where it already was.
- The buttons are absolute URLs built from `PUBLIC_BASE_URL`. A deployment that changes its
  address has a live menu pointing at the old one, and LINE will happily keep sending
  customers there.

## Known limits

- **No person has looked at it.** What was measured is that LINE created the menu, that the
  image came back byte-identical at 2500×843, that all three areas are present with the
  bounds above, and that `GET /v2/bot/user/all/richmenu` answers this id for every user. That
  a customer tapping สินค้า on a real phone reaches the catalogue is **unmeasured**, and this
  repository cannot measure it: nothing here opens the LINE app.
- **LINE's own refresh behaviour is out of reach.** LINE caches the menu, so a friend who had
  the chat open may keep seeing the old one — the standard advice is to close and reopen it,
  and that is advice rather than a measurement.
- **No upload, no per-user menus, no screen.** `/admin` cannot change the menu, and the
  *upload* half of ADR 0032's effort is untouched: a shop that wants a different picture
  calls the API again.
- **`LINE_LIFF_ID` is unset**, so decision 2 stands and the buttons land on a sign-in page
  rather than signing anyone in.
- **Re-running the creation script makes a second menu.** There is no upsert, and the id is
  read from the creation response rather than looked for, so the way to replace the menu today
  is to create the new one, set it as the default, and delete the old by id.

## Revisit when

- **A shop wants to change what the buttons say or where they go** — that is the moment to
  build the command and the screen instead of opening LINE's console, and it is the same
  moment the upload half becomes worth its cost.
- `LINE_LIFF_ID` is set and a phone has proven the app handoff: the buttons become a one-tap
  sign-in, which is decision 2 revisited with evidence rather than refused on principle.
- **The hosted build** (ADR 0016) puts more than one shop on a deployment: a rich menu is one
  object per channel, so a per-shop menu becomes a question about who owns the channel, not a
  question about the schema.
- The artwork is redrawn, or LINE changes the sizes it accepts — then the areas are
  **re-measured from the new pixels**, never carried over from the old numbers (decision 3).
