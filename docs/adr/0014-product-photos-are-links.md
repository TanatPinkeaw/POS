# ADR 0014 — A product photo is a link, not a file we hold

**Status:** accepted (2026-09-29)
**Amended (2026-10-06):** decision 8, after a shop pasted the share *page* its browser
was showing and could not get the picture onto a single tile.
**Context:** `products.image_url` and `shops.logo_url` have been in the schema since the
first migration, and three routes have written them since: product create, product
`PATCH`, and the catalogue import (`URL รูปภาพ`, with `รูปภาพ` and `ลิงก์รูป` as accepted
headers). Nothing read them. No screen drew a product photo, no screen offered a field
for one, and README's *Not built yet* said so in one line: "there is no upload and no
storage". So the column was a promise the product never kept — a shop could set it and
see nothing.

The question was what to do about it, and the reference installation answered it before
this ADR was written: the shop's pictures are in a **Nextcloud folder in the same
homelab**, on its own host. That is what a shop actually has — a file host it already
backs up, already knows, and already pays for — and it sits one origin away from the
till.

The one thing in the way was a rule this repository is proud of: `route:audit` refused
any reference that leaves the host, `<img>` included, because *"a page that breaks when
the shop's internet connection does"*.

## Decisions

### 1. The link is the feature: no upload, no storage, no new dependency

This system does not hold image bytes. It holds a link to a picture that lives where the
shop keeps its pictures, and it draws that picture. Upload and storage stay unbuilt —
they are a route, a directory or a blob column, a size and type limit, a cache, a
backup that covers the files, and a restore rehearsal for them (which does not exist for
the database yet either). None of that is needed to make a photo appear, and all of it
would make photos a feature a shop waits for rather than a link it pastes.

### 2. The link is checked, at render time, by a positive list

`src/lib/image-url.ts` accepts `https://`, `http://` and a root-relative path, and
refuses everything else: `data:` (an inline image would defeat the paging in
`product-query.ts`), `javascript:` and `file:`, a bare host (a browser resolves
`example.com/x.jpg` against the current page and fetches a 404 from the wrong place), and
protocol-relative `//host/x.jpg` (which the browser would honour, but whose destination
cannot be read off the link an operator pasted).

A positive list rather than a sanitiser: a denylist of `javascript:` and `data:` is the
version that goes stale the first time a scheme nobody here has heard of appears. The
function is pure and unit-tested for the mistakes a person makes while pasting —
surrounding whitespace, a link with no scheme, a link copied out of a page that had the
picture inline.

### 3. `route:audit` stops treating `<img>` as an off-site reference

Scripts, stylesheets, iframes, `url()`, `@import` and `@font-face` stay strict. Images
do not, for two reasons that are about size of failure rather than about taste:

- A stylesheet that fails to load leaves an unstyled, unusable screen — the exact
  failure ADR 0003 spent a migration removing. A photo that fails to load leaves one
  tile with a placeholder in it, because `Thumb` handles `onError`.
- The only alternative is holding the bytes here (decision 1), which is a decision this
  repository has deliberately not made.

**The rejected alternative is worth naming:** keep `<img>` in the rule and require photos
to be same-origin. It is the stricter reading, and it is what the rule was written for.
It was rejected because it makes the feature empty — with no upload there is nothing
same-origin to point at — so the honest version of that choice is "no product photos
yet", not "product photos, safely".

### 4. The placeholder is the default, and a broken link is a placeholder

`Thumb` (`src/components/ds/`) draws the photo when there is a usable link, and an
`image` glyph otherwise. It is decorative (`alt=""`, `aria-hidden`): every caller renders
the product's name as text beside it, and a name announced twice is noise at a counter.
It is `loading="lazy"` and `decoding="async"`, so sixty tiles do not open sixty
connections and a slow decode never blocks the till, and it sends
`referrerPolicy="no-referrer"`, so the photo host learns nothing about the shop — which
also gets around the hotlink protection a home NAS often has on.

The three fixed sizes come from the control tokens (`--ln-control-h-sm`, `--ln-control-h`,
`--ln-control-h-lg`), so the same photo is 40 px on the till's touch density and 28 px in
the back office, and no screen decides a pixel value for itself (rule 4). The fourth,
`fill`, is the documented exception: it takes its container's width with a 4:3 shape, and
the till's grid is what decides how big that is — the catalogue is built around the photo
(`TillCatalog`), so a tile is roughly four times the area it was and the picture is the
part the eye lands on. The trade is real and deliberate: fewer products per screen, in
exchange for recognising one without reading its name.

### 5. Shown wherever a product is identified, and editable after creation

The till tile (`sm`), the member storefront (`md`) and the back-office table (`sm`, inside
the name cell) all draw the same link, plus a **รูปสินค้า** dialog on the back office with
a live preview of what is being pasted and an empty box that removes the picture.

The pre-order board's two dialogs draw it too, on every line: handing a bag over is
the moment the question is *which of these is this order's*, which an order number
answers not at all and a photo answers at a glance. That put the field on
`OrderItemView` — and forced a second projection to carry it, because the handover
dialog is filled either by `/api/v1/orders/:id` or by `/api/v1/orders/lookup`, and the
lookup route builds its lines by hand. The two are now deliberately the same shape:
a counter that found the order by scanning a code and one that typed a PIN are the
same counter, and a photo that appears down one road but not the other is worse than
no photo at all.

`PATCH` rather than create-only, because a catalogue of two hundred products gets its
pictures entered long after the products themselves — and because a form that cannot
express "remove the photo" sends somebody to the database to do it.

The preview is the whole point of the dialog: a link that returns a login page, a link to
a folder rather than to a file, and a link that is simply the wrong picture all look
identical to a good one until something tries to draw it.

### 6. `imageUrl` moves from `ProductDto` into `ProductView`

`ProductDto` is the browser shape with the back-office extras (cost price, description);
`ProductView` is the client-safe one. A field the tiles draw belongs in the second:
`product-view.ts` has no database import, so it can travel into a client component
without dragging Prisma with it. The comment in `product-query.ts` that called the image
a back-office field is gone with the field.

### 7. Plain `<img>`, not `next/image`

`next/image` needs the remote hosts known at build time (`images.remotePatterns`), and
which host a shop keeps its photos on is not knowable when the image is built — it is a
link typed at a counter. A configuration file that has to be edited and rebuilt before a
photo can be added is worse than an `<img>` with `loading="lazy"`.

### 8. A public share link is read as the picture inside it

The link a shop pastes first is the one its browser was showing it, and for the file host
this ADR's Context names that link is the share's *page*: `https://…/s/<token>` answers
`200 text/html` (measured against the reference installation — 26 kB of page whose
`<title>` is the file's name), so every tile drew the placeholder and the photo dialog's
probe refused the link before it could even be saved. The picture is one segment further
along, at `/preview`, which answers `200 image/png`.

So `renderableImageUrl` rewrites the bare share root to that endpoint. The column keeps
exactly what the operator pasted, and the rewrite happens at render time in the one
function that decides what a screen may load (decision 2), which is why the probe and the
tiles cannot disagree: both call it. Every row pasted this way starts drawing without a
data migration.

**The refused alternative is the help text.** Leave the link alone and tell the operator
to append `/preview` themselves. It was rejected because it is a rule only a person who
already knows Nextcloud's URL shape can follow, and the failure is silent in the meantime
(a placeholder tile, not an error) — the same class of trap decision 2 exists to remove.

The matching is deliberately narrow, because a rewrite edits a URL somebody else serves:
only a bare share root, only Nextcloud's own alphanumeric token, only a link with a host
(`/s/<token>/preview` and `/s/<token>/download` are already endpoints and are left alone,
and a root-relative `/s/…` is this deployment's own file). What it does *not* do is check
the file: a folder share rewritten to `/preview` is a 404, which is the placeholder, which
is what a folder link did before.

## Consequences

- A shop that fills nothing in sees exactly what it saw before: a placeholder glyph on
  every tile, no request anywhere.
- A shop that pastes a link gets the picture on the till, the storefront and the back
  office, and the import path already accepts the column, so a catalogue of photos can
  be entered as a spreadsheet.
- **Every place a pasted link is drawn now reads it the same way.** Two surfaces were
  drawing one raw: the shop logo on `/display` (the owner's link, in front of customers)
  and a consignment offer's documents, whose projection carried a `drawable` flag
  computed *beside* the URL it was drawn from — so the flag could say yes while the
  `src` was still the share page. The projection carries the renderable URL itself now
  (`imageSrc`). A share link draws in all three; nothing else about those screens moved.
- `npm run backup` does **not** cover the photos — they are in the shop's own file host
  (ADR 0014 decision 1), so they are covered by whatever backs that up. The deploy doc
  says so where an operator reads about backups.
- `OrderItemView` and the lookup route's line projection both gained the link, so the
  pre-order board's handover and confirmation dialogs identify a bag by sight. Those
  two projections agreeing is now a thing to keep true by hand: nothing tests that they
  carry the same fields, and nothing would fail if one of them dropped the photo.
- The shop logo (`shops.logo_url`, drawn on `/display` and settable in
  `/admin/settings`) turns out to have been the same feature all along, one surface
  earlier. It is unchanged by this ADR and keeps working; it has no dialog of its own.
- `route:audit` now ignores `<img>` in every rendered page, which is a real narrowing of
  a check that has caught a real regression before (the Google Fonts `@import`).

## Known gaps, stated rather than discovered

- **Nothing validates what is at the other end, and nothing checks it later.** The
  allowlist (and the share-link rewrite of decision 8) judges the link, not the response.
  A link to a login page, to a 404, or to a *folder* share — which was rewritten to
  `/preview` and answers 404 — is refused by the photo dialog's probe at entry and shows
  the placeholder if it is written into the column some other way (the import, an older
  row). No periodic re-check, and nothing tells a shop that a photo which worked last week
  has stopped.
- **A link to the file itself is downloaded at its full size.** Nothing resizes. Decision
  8 fixed the common case — a share link is rewritten to the host's own preview, so the
  *host* does the resizing — but a shop that pastes the file's direct link (`/download`, a
  raw `/remote.php/dav/…` URL, a photo host's original) still spends a counter screen's
  bandwidth on a picture drawn 40 px wide, and nothing detects the difference.
- **A shop with no file host has nowhere to put a photo.** Upload and storage remain
  unbuilt, and this ADR does not shorten that list.
- **No hardcoded-image guard replaces the narrowed rule.** An off-site `<img>` written
  into a component by hand now passes `route:audit` and `ui:audit` both.
- **The two handover projections can drift.** `/api/v1/orders/:id` builds its lines in
  `order-view.ts` and `/api/v1/orders/lookup` builds its own by hand; the photo and the
  line id are in both today, and a change to one would show up as a dialog that quietly
  has no pictures rather than as a failure. Nothing tests that they agree.
- **Photos are per-browser cached only.** No HTTP cache headers are ours to set — the
  bytes come from the shop's host — so the same photo is fetched again on the next
  device.
- **The shop logo field takes the same links, without the same dialog or any
  fallback.** `/display` now draws it through `renderableImageUrl` like every product
  photo — so a share link is read as its preview and a refused link draws nothing at
  all — but it has no `onError`, so a link that 404s leaves the browser's own
  broken-image glyph in front of customers, which is a thing a product tile never does.
