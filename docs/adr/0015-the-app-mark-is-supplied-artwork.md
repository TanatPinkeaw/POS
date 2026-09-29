# ADR 0015 — The app mark is the supplied artwork, committed as a raster

**Status:** accepted (2026-09-29). This number first held a decision to *trace* the
artwork into a path; that version was replaced before it was ever committed, and it is
kept below as decision 1's rejected alternative, because the measurement behind it is the
reason this ADR exists at all.

**Context:** The shop supplied a brand kit — *Combination Mark*, *Pictorial Mark* and
*Wordmark* — as three Nextcloud links, with the instruction to use them. Everything in
this repository that shows the product's own identity was **code**, not an asset: geometry
in `src/brand/brand.ts`, drawn inline by `BrandMark.tsx`, rasterised into the same-origin
icon family by `npm run brand:icons`. The old mark was a square with its top-right corner
cut away and that corner floating outside it — a picture of what the name means.

There are two identities here and the kit could have gone to either. The **platform's** is
sign-in, the wizard, the sidebar and the error pages, and `brand.ts` says in as many words
that it must never appear on a receipt or a customer-facing page. The **renter's** is
`shops.logo_url`, drawn on `/display`. This ADR is about the first; the second is
untouched.

Four things about the supplied files decide everything below, and all four were measured
against the committed file rather than assumed:

- **The originals are rasters, and there is no vector original to ask for.** Nextcloud's
  `/s/<token>/preview` is a resize and `/s/<token>/download` is the uploaded file itself:
  PNG, RGBA, 500×500 for the Pictorial Mark. Each share holds one file — the
  `favicon-mask.svg` on every share page is Nextcloud's own UI asset.
- **The artwork is shaded, not flat.** Its solid pixels hold **5,629 distinct colours**,
  and the ink averages `#5e783c`.
- **Its alpha is a hard-cut stencil.** Of 250,000 pixels, 145,280 are clear, 104,445 are
  opaque and **275 are partly transparent**. A vector export antialiases its curves; this
  had its background removed by a threshold.
- **And the decisive one: the letter in it is a *tone*, not an outline.** The Pictorial
  Mark is a screen-shaped body filled with a gradient olive, with the letter drawn on it in
  a light tone — **14,138 pixels are near-white**, and the left stem, its widening foot and
  the bar under the screen are nearly all a threshold at luminance ≥ 105 separates cleanly.
  There is no second shape in the file to trace: the letter exists because the body under
  it is *lighter*, not because it is a contour.

## Decisions

### 1. The mark is the file. The one-colour trace is the rejected alternative, and here is what it cost.

Traced from the artwork's alpha and fitted to a 40-unit view box, a single filled path
(with its knockouts as subpaths, `evenodd`) scored **IoU 0.9942** against the artwork's own
ink mask, in 44 vertices and 479 characters. It was measured, and it was **wrong** —
because the mask it agrees with is not the mark. The mask is the silhouette of the screen,
so one path filled with `currentColor` reproduced the screen, the transparent slot under
the top edge and the highlight layer *inside* it, and **lost the letter**: what survived was
a single stem-with-a-foot, which reads as an `L`. That is not a rounding error at a counter;
it is the shop reporting, correctly, that their logo was missing a letter.

Cutting lower does not recover it. Setting aside the body and keeping only bright pixels,
**363 of the 377 components at luminance ≥ 105 — 96 % — are two pixels or fewer**, and the
count gets worse as the cut moves: this is the compression fringe of a gradient, not a
glyph. Two colours would hold the letter (a body path plus a letter path), and that is a
real option; it is rejected here because it amounts to re-drawing supplied artwork as our
own two-colour simplification, which is a decision about the brand that should not be made
quietly inside a build script.

Also rejected, and for the reason the previous version of this ADR gave: **hotlinking the
files**. A web manifest's icons must be same-origin, `route:audit` fails the build on any
off-site `url()`, `<link>` or `<script>`, and a till has to render with the line down.

### 2. One file, two consumers, and the path between them is derived

`MARK` is now `{ src, file }` — `/brand-mark.png` for the browser and `public/brand-mark.png`
for the icon generator — built from **one** string (`file: \`public${MARK_SRC}\``) so a
commit cannot change one and not the other. `BrandMark` is a plain `<img>`: not `Thumb`
(`src/components/ds/`), which lazy-loads and swaps in a placeholder icon when a *shop's
content photo* dies, neither of which belongs on a mark that is above the fold and shipped
with the app.

Every number in this document is a property of that committed file, which is what makes the
icons reproducible: `public/brand-mark.png` is the source of truth and `npm run brand:icons`
regenerates the family from it.

### 3. `brand:icons` became a resampler, and this is what that meant

The SVG path parser, the point-in-polygon even-odd fill, the supersampled polygon renderer
and the `icon.svg` writer were **deleted**; nothing in the icon pipeline knows what the mark
looks like any more. What replaced them lives in `src/lib/mark-image.ts` rather than in the
script — the split `palette.ts` records against its own script, and for the same reason: a
wrong answer here is a picture that looks *plausible*, so the arithmetic is checked by
`tests/mark-image.test.ts` (which decodes the committed artwork, renders it, and un-does
all five scanline filters against PNGs the test writes itself) instead of by looking at an
icon, and the script is left with nothing but "which icons exist, on what ground, written
where". They are:

- **A PNG decoder that reads all five scanline filters.** The old one only handled filter 0,
  because it only ever read files this script had written — the artwork is not one of those,
  so every filter has to be undone, and so has an alpha that is a threshold cut.
- **Area averaging in premultiplied space.** Every icon is a downscale (500 px of artwork
  into 48–512 px of icon), which is exactly the case where point sampling is visibly wrong:
  it keeps or loses the letter's diagonal depending on the phase of the resize. Averaging
  premultiplied keeps the transparent background from dragging dark edges into the mark, and
  dividing by the pixel's whole footprint — not by the weight that happened to be covered —
  is what stops a partly transparent pixel becoming an opaque one.
- **Placement on the artwork's own measured bounding box** (334×366 at 83,67), which is what
  a maskable icon's re-centring needed. The old `centre` flag existed because geometry in a
  40-unit box has a centre that is not necessarily the shape's; here the shape defines the
  box, so the flag had nothing left to do and is gone. `CONTENT` stays at **60 %** of the
  icon's edge, and so does the split between the rounded plate (192, 512, ICO) and the
  full-bleed one (180, 512 maskable) — that is what keeps an installed icon and the sidebar
  showing the same shape.

### 4. The plate moved to the other end of the ramp

The icons this replaced were a white mark knocked out of the brand's darkest step, which
worked because that mark was one colour and could be inverted. This artwork's ink is a deep
olive (`#5e783c` on average, darkest near `rgb(40,72,24)`), so it needs a **light** ground:
the palette's lightest step — the same `--ln-brand-50` the app's own chrome uses.

That ground is a token, `--ln-brand-plate`, rather than a rule in the mark's stylesheet:
`transparent` on the light theme, where the ink clears a light surface on its own, and
`--ln-brand-50` under `body.dark`, where the same ink would otherwise sit near **2:1**
against the shell. A component that branches on the theme is the thing `tokens.css` exists
to prevent, and a logo is not an exception. Rejected: recolouring the artwork to suit a dark
plate (that is decision 1 again), and shipping a second light-ink file (two marks, and
exactly the drift a single `MARK` exists to prevent).

### 5. `icon.svg` is deleted rather than regenerated

A raster cannot be an SVG, and a second, flatter vector drawing of the mark is the failure
decision 1 rejects. `metadata.icons` now names the PNG alone, the manifest drops its
`sizes: any` SVG entry, and `public/icon.svg` is gone. `/favicon.ico` still answers browsers
and crawlers that ask for it whether or not a page declares an icon.

### 6. Only the Pictorial Mark is taken; the wordmark stays live text

`Wordmark` composes `BRAND.nameTh` as text. The Combination Mark is the same two elements
stacked, so taking it would have added a second copy of both. A traced wordmark is a picture
of a word: it cannot be selected, cannot fall back to another face, and reflows as nothing
when a string changes. The wordmark file is also 2170×725 of letterforms, whose value is the
typeface — and the typeface is the app's, not the kit's (see the gaps).

### 7. The palette is not re-derived

`BRAND_SEED` and `BRAND_ANCHORS` are untouched, so `tokens.css`'s ramp and
`brand:palette -- --check` are too. The supplied greens sit near the olive the ramp already
starts from, which is why the mark lands on the existing chrome without adjusting it — but
the ramp has `tests/contrast.test.ts` behind it and every screen keys off it, so re-branding
the colour is its own decision with its own ADR, not a side effect of receiving a logo.

## Consequences

- The mark on sign-in, the wizard, the sidebar and the error pages, and all five icon files,
  change together in one commit from **one file**.
- Restyling the mark is now: replace `public/brand-mark.png`, run `npm run brand:icons`,
  commit both. Nothing else in the repository knows what the mark looks like.
- **The mark is reproducible from the repository.** The previous version of this ADR ended
  with "the trace is not reproducible: the source artwork is not committed and `brand.ts`
  holds no link to it". That gap is closed, and closed in the direction that matters — the
  file drawn in the sidebar is the file the tab icon is resampled from.
- The one thing a document could never check — *does it look like the shop's logo* — is now
  settable by looking at one PNG, instead of by trusting a 479-character path.

## Known gaps, stated rather than discovered

- **The mark can no longer take the surrounding colour.** `currentColor` is gone by
  construction: `--ln-brand-plate` is the *ground* under the artwork, not a tint on it, and
  nothing in CSS can recolour one channel-range of a gradient. Anything monochrome — a
  printed receipt header, an email, an embroidery — has no single-colour mark in this
  repository and would have to derive one from the raster.
- **The dark theme shows the mark plated.** On a dark surface the artwork sits on a cream
  `--ln-brand-50` square rather than directly on the shell. That is the deliberate price of
  decision 4 and it is visible; what it is not is a logo at 2:1.
- **97 KB of binary is now the only copy of the identity.** The geometry it replaced was 479
  characters in a TypeScript file, diffable and reviewable. This cannot be diffed, reviewed
  or merged in a text sense. A truncated or wrongly saved replacement *is* caught —
  `tests/mark-image.test.ts` decodes it and insists it is still a mark on a transparent
  ground, and `decodePng` refuses a format it does not handle by name — but a valid PNG of
  the wrong logo passes every gate in this repository, and only a person can catch that.
- **The letter is small at small sizes.** `favicon.ico` is a single 48 px entry, as it was
  before this change, where the letter is a few pixels of tone inside the screen. That
  is the artwork's own proportion rather than a rendering fault, and it is the cost of
  decision 1: the alternative was a favicon of a mark that had no letter in it at all.
- **The alpha is somebody's threshold cut, so the edges are.** The mask was cut by a
  threshold, and no resampler can restore an antialiased edge that was never exported; at
  512 px the mark's own boundary is one pixel of fringe. A re-export with a real alpha would
  improve every icon and is a request to the shop, not a fix here.
- **The lockup is still the app's typeface, not the supplied one.** `Wordmark` composes the
  mark with `nameTh` in the UI font (decision 6), so the platform's name does not match the
  kit's wordmark.
- **`src/brand/BrandMark.tsx` exports a `Wordmark` whose `ln-lockup*` classes no stylesheet
  defines.** It has no caller in `src/`, and the classes it asks for were not carried into
  the design system. Left for the piece of work that gives the lockup a home (or deletes
  it); it is named here rather than quietly fixed so the next reader does not conclude
  `Wordmark` is a working component.
- The shop's own logo (`shops.logo_url` on `/display`) is unchanged, and ADR 0014's gap
  about it — no allowlist, no `onError` fallback — is still open and still its own piece of
  work.
