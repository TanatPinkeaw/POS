# ADR 0031 — The build picks the phone, not the other way round

**Status:** accepted (2026-10-07). Constrains every screen a customer opens, and is
asserted by `npm run browser:target` inside `verify:all` and in CI's second job. It
amends no feature decision; it fixes the target they were compiled for.

**Context.** A customer opened `/login` on an iPhone 7 Plus. The page rendered — the
LINE button, the phone-and-password form, the staff toggle — and the Google box was
empty. The obvious reading, "the phone is too old", was half right and useless: an
iPhone 7 Plus cannot be updated past iOS 15.8.3, and on iOS **every** browser is
WebKit, so Safari, Chrome and LINE's own in-app browser share one engine and one
syntax ceiling. There was no browser to switch to.

Measured rather than inferred. The chunk `/login` loaded
(`/_next/static/chunks/19mx3mg6lkumu.js`) failed `acorn.parse(code, { ecmaVersion: 2021 })`
at offset 667, and parsed at `ecmaVersion: 2022`. The token there is Next's own App
Router client runtime:

```
class y extends i.default.Component{static{this.contextType=d.AppRouterContext}
```

A **class static block** — ES2022, first implemented in Safari 16.4. A chunk that
cannot be parsed is a chunk that never runs: React never hydrated, the `useEffect`
that injects Google's button never ran, and the empty box was the visible tip of a
page with no JavaScript at all. The LINE button worked because it is a plain `<a>`;
everything else on that page was dead, including the form the customer needed.

The cause is a default, not a mistake in our source. With no browserslist config,
Next 16 compiles for "baseline widely available" — chrome 111, edge 111, firefox 111,
**safari 16.4** (`node_modules/next/dist/shared/lib/modern-browserslist-target.js`) —
and hands that list to Turbopack as its `browserslistQuery`. Nothing in this repository
said what the shop's customers actually hold, so the framework answered for us.

## Decisions

### 1. The floor is Safari 15.6, written down in `.browserslistrc`

One file, five lines, everything except Safari left exactly where Next put it:
`chrome 111`, `edge 111`, `firefox 111`, `safari 15.6`, `ios_saf 15.6`. 15.6 is the
newest Safari 15, and therefore the ceiling of the phone that found this: not a
version we chose for elegance but the last one an iPhone 7 Plus or 6s can reach.
`ios_saf` is pinned beside `safari` because an iOS number is not a desktop Safari
number, and pinning only the desk would have left the phone unpinned.

This is a floor for the whole application, including the till. Lowering the target
costs a little code size in every bundle and buys the only thing that matters here:
the customer's own phone runs the page.

### 2. A gate reads the artefact, because nothing else can see this

`npm run browser:target` asks two questions, and they are different questions:

- **Is the floor still where this ADR put it?** A missing `.browserslistrc` is not an
  oversight here; it is the original bug returning, silently, because its absence is
  what restores Next's default. A pin that has drifted above 15.6, or a tidy-up that
  deletes the `ios_saf` line as "redundant", fails the same way.
- **Did the emitted code honour it?** A config can be present and not applied, and a
  dependency can arrive pre-built. So every `.js` under `.next/static` is parsed.

The grammar ceiling is **ES2022**, not ES2021, deliberately. Safari 15.6 does
implement class fields (public, private, static), top-level await, `Array.prototype.at`,
`Object.hasOwn` and the `d` flag on a regular expression — flagging the whole ES2022
grammar would fail code that phone runs perfectly well, and a check that cries wolf is
worse than no check. What it genuinely cannot parse is narrower, and both features are
named: a **class static block** and **`#x in obj`** (both Safari 16.4). Anything the
ES2022 grammar cannot express at all is reported as well, which covers the future
without a list to maintain.

The detection is pure (`src/lib/browser-target.ts`) and unit-tested against samples
*and* against this repository's own `.browserslistrc`; walking `.next` and printing the
report is `scripts/browser-target.ts`. It runs in `verify:all` immediately after
`route:audit`, reading the one build the journey made, and in CI's second job beside
the other gates that read that build. It sits there and not in `verify` because it
cannot answer anything without a build — and it is in the gate list at all because the
failure is invisible everywhere else: the build is green, the tests are green,
`route:audit` confirms every class is styled, and the page still does nothing on the
phone it was written for.

### 3. Translucent colour is written down, not mixed while the page paints

`color-mix()` is Safari 16.2. Twenty-one uses of it were spread across the design
system, and what an engine without it does is worse than the phrase "unsupported
value" suggests: for a declaration containing a `var()` — which every one of these
did — the browser cannot rule it out at parse time, so the declaration survives the
cascade and *then* becomes invalid at computed-value time, which leaves the property
unset rather than restoring the declaration it beat. The tint did not go missing; the
property went missing. A field's focus ring was a field with no ring, and a page
background written as `radial-gradient(…), var(--ln-bg)` lost its canvas along with
its glow — a white page under a dark theme, which is how this was found rather than
by anyone measuring a Tint.

The decision is that **every translucent colour is a value**, and the work splits by
where the colour comes from:

- **Derived from the ramp → generated.** `renderRampBlock` emits the brand alphas
  (`--ln-brand-600-a35`) and each category hue's wash (`--ln-cat-blue-wash`) beside
  the colour they come from, and the semantic layer points at them. Re-anchoring the
  brand therefore moves the tints in the same command, which is the property a
  hand-written `rgba()` beside the ramp would have quietly lost.
- **Hand-picked tones → written beside their base, and checked.** The status colours
  are chosen, not built from anchors, so their derivations (`--ln-danger-line`,
  `--ln-danger-ring`, `--ln-success-hover`, `--ln-on-brand-soft`) are hand-written —
  and `tests/contrast.test.ts` recomputes each one from the token it derives from and
  fails if the two disagree. That is what replaces the generator here: a rebrand that
  forgets one prints the value it should have been.
- **`currentColor` → `opacity`, because there is nothing else.** The loader's three
  rings are `currentColor` at 35 %, 60 % and 100 %, and the dynamic colour is the
  point (a filled button's spinner has to be the button's white). The only alpha
  available without `color-mix()` is `opacity`, and an element's opacity reaches its
  descendants — so the rings became three sibling spans instead of an element and its
two pseudo-elements. Nesting them would have dimmed the inner two by the outer one's
  35 %.

**Rejected: wrapping each use in `@supports`.** It works — an `@supports` condition
contains no `var()`, so it is evaluated by syntax and an old browser simply skips the
block — but it leaves two values for one colour in every rule, one of them a recipe
and one an approximation, and the whole point of the semantic layer is that a colour
is decided in one place. Precomputing also removes the paint-time work rather than
keeping it for newer devices.

**Rejected: leaving it.** The JavaScript layer made the page *usable*; this layer is
what a shop's customer sees when they open the sign-in page on their own phone, and
on the phone this ADR exists for, three of those pages painted a white canvas in dark
mode.

Four values changed by a hair, each named so a reviewer can see it: a destructive
outlined button's border is the notice hairline's 35 % rather than 45 % (the same
pixel on a 1 px border), a supervisor dialog's error fill is `--ln-danger-soft`
rather than an 8 % wash of its own, the skeleton's shimmer stop is `--ln-border`
rather than a 60/40 mix of `--ln-surface-2` and it (within 4/255 in light, 7/255 in
dark), and the brand page's veil is the sign-in cards' 12 % rather than 10 %.

What holds it: `tests/contrast.test.ts` fails if any stylesheet under `src/` mixes
colours at paint time, and its token resolver no longer has a `color-mix()` branch to
take — a token that went back to mixing resolves to nothing and the assertion that
needs it fails. `:has()` in the same file needs no work: Safari 15.4 has it, and it
was checked rather than assumed.

### 4. What is knowingly not fixed here

- **Runtime APIs.** No syntax tree can see `AbortSignal.timeout` (Safari 16) or
  `URL.canParse` (Safari 17). The client bundle was searched for the ones this phone
  lacks and carries none: both of those are server-side calls here, and
  `crypto.randomUUID` on the account page is Safari 15.4. A property *call* is not
  statically typeable in a minified bundle, so the fence is the phone test below, not
  this gate.
- **Behaviour on the phone.** Playwright is Chromium. The gate proves the syntax level
  the build promises; only the device proves the page works. The test that closes this
  is two taps on the owner's own iPhone 7 Plus: the staff toggle must open (JavaScript
  is alive at all), the Google button must appear, and a dark-mode page must still have
  a canvas rather than a white one.

## Consequences

- One more file at the repository root, a little more downleveled code in every
  bundle, and a gate that reads a build. In exchange, the shop's customers can use the
  page on the phones they have rather than the ones the framework assumes.
- The framework's supported baseline is Safari 16.4; this repository now ships below
  it. That is a target we set, not one Next tests, so a future release could emit
  something unreadable again — which is exactly why the gate parses the artefact
  instead of trusting the config, and why the config check exists beside it.
- The till's screens lose nothing: they run on a modern browser and were never the
  reason for the floor.

## Revisit when

- Customer phones move past iOS 15 as a group — a shop whose customers are all on
  current devices could take the target back up, and should check the floor's comment
  before doing it.
- Next offers a per-surface target, at which point the till can keep the modern one
  while `/login`, `/shop/*`, `/receipts` and `/display` keep the low one.
- A future floor reaches Safari 16.2, at which point `color-mix()` could come back as
  a simplification rather than a hazard — every value here is still derived from a base
  token, so the recipes are reconstructible from what is written down.
