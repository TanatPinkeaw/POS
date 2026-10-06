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

### 3. What is knowingly not fixed here

- **CSS.** `color-mix()` is Safari 16.2 and appears in 21 places, several of them
  semantic tokens (`--ln-brand-soft`, `--ln-brand-ring`, `--ln-brand-soft-border`). On
  iOS 15 those declarations are invalid at computed-value time, so the tint or ring they
  define is simply absent — text stays legible and nothing stops working, which is why
  the JavaScript layer was fixed first and this one was left. Two candidates are
  recorded for when it is done: compute the mixes in `brand:palette` and emit plain
  values, or keep `color-mix()` and wrap every use in `@supports`. `:has()` in the same
  file needs no work — Safari 15.4 has it, and it was checked rather than assumed.
- **Runtime APIs.** No syntax tree can see `AbortSignal.timeout` (Safari 16) or
  `URL.canParse` (Safari 17). The client bundle was searched for the ones this phone
  lacks and carries none: both of those are server-side calls here, and
  `crypto.randomUUID` on the account page is Safari 15.4. A property *call* is not
  statically typeable in a minified bundle, so the fence is the phone test below, not
  this gate.
- **Behaviour on the phone.** Playwright is Chromium. The gate proves the syntax level
  the build promises; only the device proves the page works. The test that closes this
  is two taps on the owner's own iPhone 7 Plus: the staff toggle must open (JavaScript
  is alive at all) and the Google button must appear.

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
- The `color-mix()` layer is fixed, which retires decision 3's first bullet.
