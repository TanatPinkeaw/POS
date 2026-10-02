# ADR 0021 — The electronic receipt is generated, not stored

**Status:** accepted (2026-10-02).

**Context.** A shop with no receipt printer still hands the customer something — CONTEXT
item 13 already decided the shape: a slip the till draws with the Canvas API, as a picture.
The ask here is broader: **stop printing paper at all**, and give the customer an electronic
receipt they can keep, with the last month available on demand. The receipt has to live
"in an account" (both the shop's and the customer's) — and the customer may be a walk-in
with no account at all.

Two facts constrain the shape:

- **Nothing in this system stores files.** A product photo is a *link* the shop pastes
  (ADR 0014); there is no object store, no upload, no bucket. Introducing one is a large new
  surface — its own backup, its own access control, its own cost — for a document the
  system can already derive.
- **The order row is already a complete, immutable record of the sale** — prices, tax,
  numbers, cashier, drawer, points — and it is kept indefinitely (the tax series is gapless
  and Thai tax documents are retained for years). A stored receipt image can only ever be a
  *rendering* of that row, and a rendering that sits in storage is a second source of truth
  that can drift from the first.

## Decisions

### 1. The receipt is generated on demand, from the order

There is no stored receipt file. When a customer (or the shop) asks for a receipt, the till
or the portal draws it as an image with the Canvas API from the order's own data — the same
shape CONTEXT item 13 chose for the printer-less slip. The *authoritative* record is the
order row; the image is derived.

### 2. "One month" is an access window, not a retention rule

The order data is kept as it is today — indefinitely, because it is a tax document and
because the receipt series may not have a hole. The customer may **download** the receipt
image for the **last month**; older bills remain visible in their order history, only the
file is no longer offered. Nothing is deleted at any point: deleting a tax document after a
month would break the retention and the gapless-series story at once.

### 3. Access without an account is a signed link

A walk-in who never registers still gets an electronic receipt, through a **signed link**
handed over at the counter — the same discipline as the pickup code (`pickup-token.ts`): the
link names exactly one order, it expires, and its own audience means another session cannot
present it. A signed-in customer gets the same document from their portal.

### 4. One renderer to keep in step, and that cost is accepted

Drawing a slip in Canvas means a **second renderer** beside the DOM receipt
(`Receipt.tsx`), and the two have to be kept in step by hand — the drift the repository
normally refuses to create. The alternative (storing the rendered file) trades that drift
for a storage layer and a second source of truth, which is worse: a stored image can silently
disagree with the order it claims to show, and nobody finds out. The image is a convenience
over the record, never the record itself.

## Consequences

- **No new storage, no new dependency.** The feature is a renderer and an access rule, not
  an infrastructure project.
- **The image is not searchable or machine-readable** the way a stored PDF with text is; if
  a shop later needs a PDF or an emailed attachment, that is a rendering decision, not a
  re-architecture.
- **Signed links need the same care as pickup codes**: short expiry, single order, and
  reissue rather than reuse.

## Known gaps

- **No PDF.** The decided format is an image (CONTEXT item 13); a PDF would need either a
  dependency or browser print, and neither is chosen.
- **The link's lifetime is not yet set**, and neither is whether a link is reissued per open
  or is stable per order.
- **Nothing is built.** `Receipt.tsx` renders a screen today; the image renderer and the
  signed link do not exist.
