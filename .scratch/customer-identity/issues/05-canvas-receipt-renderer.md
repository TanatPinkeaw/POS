# 05: One renderer that draws a receipt as an image

**What to build:** A receipt drawn as an image from an order's own data, with no stored file.

**Blocked by:** None.
**Status:** ready-for-agent

- [ ] A Canvas renderer that draws the same document `Receipt.tsx` renders, from the order's
      figures — the "printer-less slip" shape CONTEXT item 13 already decided.
- [ ] The figures come from the order (prices, tax, numbers, cashier, drawer), never
      recomputed from today's catalogue.
- [ ] The same order renders the same image twice.
- [ ] A Chromium test in the style of `offline:browser` covers the render, so the browser API
      is exercised rather than mocked.
- [ ] Tests: the drawn document matches the order; a re-render is identical; a VAT bill and a
      non-VAT bill both render.

## Notes

This is a **second renderer** beside the DOM receipt, kept in step by hand — the drift the
repository normally refuses (ADR 0021 §4). It is accepted because the alternative is a stored
file that can silently disagree with the order it claims to show.
