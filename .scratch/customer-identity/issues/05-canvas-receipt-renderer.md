# 05: One renderer that draws a receipt as an image

**What to build:** A receipt drawn as an image from an order's own data, with no stored file.

**Blocked by:** None.
**Status:** done

- [x] A Canvas renderer that draws the same document `Receipt.tsx` renders, from the order's
      figures — the "printer-less slip" shape CONTEXT item 13 already decided.
- [x] The figures come from the order (prices, tax, numbers, cashier, drawer), never
      recomputed from today's catalogue.
- [x] The same order renders the same image twice.
- [x] A Chromium test in the style of `offline:browser` covers the render, so the browser API
      is exercised rather than mocked.
- [x] Tests: the drawn document matches the order; a re-render is identical; a VAT bill and a
      non-VAT bill both render.

## Continuation checkpoint

Two modules, split by what each may import:

- `src/lib/receipt-canvas.ts` — **import-free**. It knows only how to put a line on a canvas
  (`receiptCanvasHeight`, `drawReceipt`, the `ReceiptCanvasLine`/`ReceiptCanvasOptions` shapes,
  and `DEFAULT_RECEIPT_CANVAS` at 384px — a 58mm roll at 8 dots/mm). Being import-free is what
  lets the browser journey compile it alone and run it in real Chromium, exactly the way
  `offline-db.ts` is probed.
- `src/lib/receipt-image.ts` — the document's **content**. `buildReceiptLines(shop, data, when)`
  walks `ReceiptData` row for row in the same order, with the same Thai labels and the same
  snapshotted figures, as `Receipt.tsx`; `drawReceiptToCanvas` sizes a canvas to the document
  before drawing (a canvas cannot grow, which is why the height is its own function);
  `receiptImageDataUrl` returns a PNG data URL.

**This is a second renderer, kept in step with the DOM receipt by hand** — the drift the
repository normally refuses, accepted in ADR 0021 §4 because the alternative (storing the
rendered file) buys a second source of truth that can silently disagree with the order it
claims to show. If a row changes in `Receipt.tsx`, it must change here too; that cost is the
point, and it is stated in the module header.

The figures are read from the order, not recomputed: `netThb`/`vatThb` are the *stored* split,
`discountThb`/`finalAmountThb`/`changeThb` are the order's, and tenders print what was handed
over (`tenderedAmount`), so the lines always add back up to the total. No catalogue or shop
setting is consulted for a figure.

**Verified on the current tree.** `tests/receipt-image.test.ts` (14 cases) pins the label/value
rows of a VAT bill and a cash bill, the discount and the stored tax split, the "no tax line and
no tax id on a non-VAT bill" rule, the per-tender legs and change, the earned/spent points, and
the footer fallback; plus `receiptCanvasHeight`'s arithmetic. The drawing itself is checked in
**real Chromium** by a new `receiptProbe` in `scripts/offline-browser.ts` (8 checks): it
transpiles the eight pure modules to CommonJS, wires them in the page, and asserts the PNG data
URL, a byte-identical second render, a canvas sized to the document with ink on it, the drawn
strings (order number, tax split, tenders, footer), and that a VAT bill and a cash bill are
different images with no tax line on the latter. `npm run typecheck` is clean and
`npm run offline:browser` reports 29 checks (was 21).

**Two honesty notes.** (1) The ticket's parenthetical "cashier, drawer" is broader than the DOM
receipt the renderer mirrors: `Receipt.tsx` prints neither today, so the image prints neither —
the source of truth is the component, and adding those figures means adding them to both
renderers at once. (2) The renderer is **built but not yet wired to any screen**; ticket 06
(the signed link and one-month access window) is what gives a customer a way to reach it, so
nothing in the app imports it yet and it is exercised only by the suite and the browser harness.

Source: ../spec.md and ../../../docs/adr/0021-the-electronic-receipt-is-generated.md.
