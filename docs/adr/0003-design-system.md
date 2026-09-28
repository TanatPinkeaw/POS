# ADR 0003 — The เหลี่ยมนอก design system, and how it replaces Hope UI

**Status:** accepted, migration in progress

---

## Context

The first milestone vendored Hope UI (Bootstrap 5, MIT) and built every screen
from its class names. That was the right call for a vertical slice and the wrong
one for a product, for three reasons that only became visible once the screens
existed:

1. **Nothing was ours.** The favicon, the sidebar logo and the palette were the
   theme's. Two identities were conflated — the platform the shop runs on, and the
   shop itself — so a renter's system looked like a template somebody had themed.
2. **Bootstrap utility classes are not a component library.** 30 files carried
   1,447 occurrences of `d-flex`/`card`/`btn`/`text-muted`, each screen inventing
   its own table, its own empty state, its own form wiring. `src/components/hope/ui.tsx`
   existed only to paper over the smallest of those.
3. **The theme could not be removed.** Deleting it meant rewriting all 30 screens
   in one commit, so it could never be deleted.

---

## Decisions

### 1. The brand is the platform's; the shop's identity is the shop's

`src/brand/brand.ts` holds the name (เหลี่ยมนอก / Liam Nong), the copy, and the
mark geometry. It appears on the sign-in screen, the wizard, the sidebar lockup,
the error pages and the documentation — **and never on a receipt, a reprint or a
customer-facing page**, which carry the renter's name and (soon) their logo.

The sidebar deliberately shows *both*: our mark, the shop's name as the title.
That is how self-hosted shop software reads — the platform's mark, the shop's
identity — and it keeps the promise that the app feels like the renter's system.

### 2. Colour is generated from one seed; semantics are hand-written

`src/brand/brand.ts` holds `BRAND_SEED`. `npm run brand:palette` derives a ten-step
brand ramp and a twelve-step neutral ramp into a marked block of
`src/design/tokens.css`. The semantic layer below that block is written by hand
and is the only thing components may reference: `--ln-brand-600` is a colour,
`--ln-brand` is a *decision* ("this is the colour of an action"), and dark mode
changes the decision without touching a component.

Two implementation notes that are easy to get wrong twice:

- **Mixing happens in sRGB, not linear light.** Linear-light mixing compresses
  the dark end — a 91 % mix toward black lands on `#555661`, a mid-grey — so a
  "900" step used as body text comes out washed out. It was tried, it was wrong,
  and `tests/palette.test.ts` now asserts the ramp steps monotonically darker.
- **Linear light *is* used for luminance**, because WCAG contrast is a physical
  quantity. `readableTextOn()` picks the text colour on a filled surface by ratio
  rather than by taste.

### 3. No Tailwind, no icon package, no image library

Consistent with the rest of this project (a hand-rolled CSV parser, a hand-rolled
THB formatter, no Bootstrap from npm). The design system is CSS custom properties
plus CSS Modules, the icons are one file of path data, and the app icons are
rasterised by `scripts/build-icons.ts` — which is also why the favicon, the
sidebar mark and the maskable Android icon cannot drift: they are all rendered
from `MARK`.

### 4. The brand lands everywhere *before* the migration does

`tokens.css` also overrides the four variables Hope UI reads
(`--bs-primary`, `--bs-primary-rgb`, `--bs-primary-tint-20/-90`) under `html:root`,
because Next injects our stylesheet *before* the linked Hope UI sheets and a bare
`:root` would lose the cascade.

This is the load-bearing trick of the whole migration: the brand is applied to all
13 screens in one commit, while the screen-by-screen rewrite proceeds underneath.
There is never a half-restyled state, and the migration can stop at any point
without leaving the product looking broken.

### 5. Screens migrate one at a time, and Hope UI goes last

Hope UI's stylesheets stay loaded until the final screen moves. `npm run ui:audit`
(added with that commit) fails the build if a Bootstrap class name, a `data-bs-*`
attribute, or a `/hope-ui/` reference reappears in `src/`. Deleting the theme
first would break every screen that still depends on it; deleting it last makes
the removal a verifiable event rather than a hope.

### 6. Accessibility is an acceptance criterion, not a follow-up

Element-level resets are prefixed with `html` (specificity, not decoration) so they
win against Hope UI without `!important`; `:focus-visible` is used everywhere and
`outline: none` appears nowhere; every control is at least `--ln-tap` (44px) tall;
Thai text gets a 1.65 line-height floor because tone marks sit above the line and
vowel tails below it, and a copy set at 1.4 clips วรรณยุกต์; and every form control
wires its own `label`, `aria-describedby` and `aria-invalid` rather than leaving it
to the caller. A rewrite is exactly when that work is lost, so it is written down
as a criterion.

---

## Consequences

- Rebranding is a one-line change plus two commands. `npm run verify` fails if the
  checked-in ramp does not match the seed.
- The error boundary's stylesheet is preloaded on every route, which the dev server
  warns about. That is intentional and documented in the module: an error page
  whose CSS arrives late is an unstyled page at the worst moment.
- The design system is ~14 primitives today, not a complete set. `Modal`, `Sheet`,
  `Toast`, `Tabs`, `Numpad` and `DateRange` are still to come, and screens must not
  invent their own in the meantime.

## Revisit triggers

- The last screen migrates → remove the vendored theme, the Bootstrap JS and the
  bridge, in one commit, with `ui:audit` proving it.
- A second product needs a different brand → the seed and `src/brand/` are the
  seam; the tokens already treat colour as data.
- A designer joins → decisions 2 and 3 are the ones to argue about first.
