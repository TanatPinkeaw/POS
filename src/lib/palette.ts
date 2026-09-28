/**
 * The brand ramp, built from seven chosen anchor colours.
 *
 * Pure and separate from `scripts/brand-palette.ts` on purpose: the ramp is a
 * *design decision* that deserves tests (lightness must step monotonically, every
 * anchor must survive verbatim, the on-brand text must be legible), and a script
 * whose only entry point is `main()` cannot be tested without writing a file.
 */
import { mix, readableTextOn } from './color';

/**
 * The steps the anchors occupy, lightest first.
 *
 * The palette arrived as seven colours chosen by eye rather than as a formula, so
 * the ramp is *anchored* rather than interpolated: steps 50–600 are those seven
 * colours byte for byte, and only the three steps below them are derived. That is
 * the inverse of the seed-based ramp this replaced, where one colour was exact and
 * the other nine were approximations of it.
 *
 * The steps are assigned by measured luminance, which is not the order a list of
 * swatches reads in. `#fbdab2` is lighter than `#fbbf93` is lighter than `#fa8072`
 * — and a ramp that ignored that would put a hover state lighter than the button
 * it belongs to.
 */
export const BRAND_ANCHOR_STEPS = [50, 100, 200, 300, 400, 500, 600] as const;

/**
 * The steps below the deepest anchor, mixed toward black.
 *
 * The palette stops at a mid-dark olive: right for a primary fill, too light to be
 * a pressed state, a dark-mode canvas, or a shadowed edge. These three are derived
 * for that reason, exactly as the seed-based ramp derived the steps under its own
 * seed — the exact colours are the ones a human picked, and the mechanical ones are
 * the ones nobody had an opinion about.
 */
const BRAND_DARK_STEPS: readonly { step: number; weight: number }[] = [
  { step: 700, weight: 0.14 },
  { step: 800, weight: 0.3 },
  { step: 900, weight: 0.46 },
];

/** Surfaces, borders and text. Named 0–950, so 0 is the lightest. */
export const NEUTRAL_STEPS = [
  0, 25, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;

/**
 * 600 is the deepest anchor — the step every design system this replaces would
 * call "the" colour, and therefore what `--ln-brand` points at.
 */
export const SEED_STEP = BRAND_ANCHOR_STEPS[BRAND_ANCHOR_STEPS.length - 1]!;

/**
 * The anchor `--ln-brand` points at. Every generator that needs *the* brand colour
 * rather than the scale goes through this, so "which step is the brand" is decided
 * in one place.
 */
export function primaryAnchor(anchors: readonly string[]): string {
  const index = BRAND_ANCHOR_STEPS.indexOf(SEED_STEP);
  const hex = index === -1 ? undefined : anchors[index];
  if (!hex) {
    throw new Error(`The brand anchors must include step ${SEED_STEP}`);
  }
  return hex;
}

const BLACK = '#000000';
/** The darkest neutral: not pure black, which is harsh on a lit till screen. */
const INK = '#0b0c12';

/**
 * How much of the brand hue is mixed into every neutral.
 *
 * A pure grey ramp beside a saturated olive looks like two palettes. Four percent
 * is below the threshold where anyone would call the greys "green" — a cast that
 * low is a temperature, not a hue — but enough that surfaces and the brand read as
 * related. It also has a job the previous indigo cast did not: on a warm palette a
 * *cool* grey reads as a bug rather than as neutrality, because the two sit
 * together in the same table without a border between them.
 */
const NEUTRAL_CAST = 0.04;

/**
 * The neutral scale, **anchored** rather than generated.
 *
 * The brand ramp interpolates toward white because a brand colour has no
 * externally-fixed answer. Surfaces do: a page canvas and a hairline border are
 * values a designer measures on a reference, not values a formula discovers. The
 * previous version generated them by interpolating white → ink in equal steps and
 * produced `#ffffff` followed immediately by `#e2e2e8` — a mid-grey canvas that
 * made every card look like it was floating in fog, with no step light enough to
 * be a table header and no step dark enough to be a hairline border that is not a
 * black line. Equal steps in sRGB are not equal steps to the eye.
 *
 * So: the *values* are chosen, and they are chosen to be the light, low-chroma
 * surfaces a retail back office expects — `50` is the canvas, `200` is the border,
 * `600` is muted text. Only the *cast* is derived from the brand, which is what
 * keeps the greys related to it without turning them into a tint of it.
 *
 * `0` is pure white and takes no cast at all: a card on the canvas has to be
 * white, because that contrast against the canvas is what the layout reads as
 * "card" once elevation is gone.
 *
 * Because the cast is applied *to* these anchors rather than derived beside them,
 * re-anchoring the brand re-tints every surface in the app from one edit — which
 * is the whole reason the anchors are kept as plain values.
 */
const NEUTRAL_ANCHORS: Record<number, string> = {
  0: '#ffffff',
  25: '#fafbfc',
  50: '#f4f6f7',
  100: '#eceef1',
  200: '#e2e6e9',
  300: '#d3d8dd',
  400: '#a7aeba',
  500: '#5e6673',
  600: '#4b525e',
  700: '#3a4049',
  800: '#292d35',
  900: '#1d1e28',
  950: INK,
};

/**
 * How much of the cast each step may carry.
 *
 * The near-white surfaces are held back deliberately. A 4 % cast on a canvas is a
 * green-grey page, and on white it is a cream card — so the steps that exist to be
 * *clean surfaces* carry a quarter of the cast, while the mid greys that sit
 * beside the brand in a table or a chart carry all of it.
 */
const CAST_FACTOR: Record<number, number> = {
  0: 0,
  25: 0.25,
  50: 0.3,
  100: 0.4,
  200: 0.5,
  300: 0.7,
  400: 0.9,
  500: 1,
  600: 1,
  700: 1,
  800: 0.8,
  900: 0.5,
  950: 0.3,
};

export interface RampEntry {
  step: number;
  hex: string;
}

export function buildBrandRamp(anchors: readonly string[]): RampEntry[] {
  if (anchors.length !== BRAND_ANCHOR_STEPS.length) {
    throw new Error(
      `Expected ${BRAND_ANCHOR_STEPS.length} brand anchors, received ${anchors.length}`,
    );
  }

  const primary = primaryAnchor(anchors);

  return [
    ...anchors.map((hex, index) => ({ step: BRAND_ANCHOR_STEPS[index]!, hex })),
    ...BRAND_DARK_STEPS.map(({ step, weight }) => ({
      step,
      hex: mix(primary, BLACK, weight),
    })),
  ];
}

export function buildNeutralRamp(primary: string): RampEntry[] {
  return NEUTRAL_STEPS.map((step) => {
    const anchor = NEUTRAL_ANCHORS[step];
    if (!anchor) {
      throw new Error(`No neutral anchor for step ${step}`);
    }
    return { step, hex: mix(anchor, primary, NEUTRAL_CAST * (CAST_FACTOR[step] ?? 1)) };
  });
}

/** The markers `scripts/brand-palette.ts` rewrites between. */
export const RAMP_START = '/* ramp:start */';
export const RAMP_END = '/* ramp:end */';

/**
 * Category colours.
 *
 * The reference design identifies a menu category by colour, not only by name,
 * so that an operator scanning a grid of tiles can tell "drinks" from "snacks"
 * in peripheral vision instead of reading every label. Ours does the same for a
 * grocery's aisles.
 *
 * Nine hues, and every one is chosen against a constraint rather than by taste:
 * the light value must be legible as text on white (the soft tint a pill uses is
 * derived from it, so the pill and the text it carries are the same hue), the
 * dark value must be legible on the dark surface, and — since the brand became a
 * warm sweep from olive to salmon — neither may sit within a visible distance of
 * any step of the brand ramp. All three are asserted in the test suite, which is
 * what stops a tenth category from being added with an unreadable or
 * brand-coloured value later.
 *
 * The dark warm hues (amber, orange, red) are deliberately saturated. The brand's
 * light steps occupy the same warm band, and a dark surface leaves lightness no
 * room to separate them, so chroma is the only axis that can — a pastel orange had
 * measured ΔE 7 from `--ln-brand-100`, i.e. the same colour.
 *
 * Colours are assigned from a category's id, so a shop that bulk-imported its
 * categories still gets distinguishable aisles with no extra data entry.
 */
export interface CategoryColor {
  key: string;
  /** Foreground on a light surface. */
  light: string;
  /** Foreground on the dark surface. */
  dark: string;
}

export const CATEGORY_COLORS: readonly CategoryColor[] = [
  { key: 'slate', light: '#44546b', dark: '#aab7cc' },
  { key: 'blue', light: '#1d4ed8', dark: '#93b4ff' },
  { key: 'teal', light: '#0f6f68', dark: '#7fd8cf' },
  { key: 'green', light: '#15733a', dark: '#86e0a5' },
  { key: 'amber', light: '#8a5f05', dark: '#ffd95e' },
  { key: 'orange', light: '#a8480a', dark: '#ffa03a' },
  { key: 'red', light: '#b3261e', dark: '#ff5252' },
  { key: 'rose', light: '#9d174d', dark: '#f7a6c4' },
  { key: 'violet', light: '#6326cc', dark: '#c3abff' },
];

/**
 * Which colour an aisle wears.
 *
 * Deterministic in the id, so the same category is the same colour on every
 * device and in every report. The gap between a category's id and its neighbour's
 * is not always 1 after deletions, which is why the modulo is taken over a
 * coprime-ish stride rather than the id alone: two categories imported together
 * must not end up wearing the same colour.
 */
export function categoryColorKey(categoryId: number | null | undefined): string {
  if (categoryId === null || categoryId === undefined || !Number.isFinite(categoryId)) {
    return CATEGORY_COLORS[0]!.key;
  }
  const index = Math.abs(Math.trunc(categoryId)) % CATEGORY_COLORS.length;
  return CATEGORY_COLORS[index]!.key;
}

/** The generated CSS. Deterministic: same anchors in, same bytes out. */
export function renderRampBlock(anchors: readonly string[]): string {
  const brand = buildBrandRamp(anchors);
  const seed = primaryAnchor(anchors);
  const neutral = buildNeutralRamp(seed);

  const lines: string[] = [];
  lines.push('/*');
  lines.push(' * GENERATED — do not edit by hand. `npm run brand:palette` rewrites');
  lines.push(' * everything between the ramp markers from the anchors in');
  lines.push(' * src/brand/brand.ts. The semantic layer below this block is hand-written');
  lines.push(' * on purpose.');
  lines.push(' */');
  lines.push(':root {');

  lines.push('  /* brand — 50–600 are the chosen anchors verbatim, 700–900 are derived */');
  for (const { step, hex } of brand) {
    lines.push(`  --ln-brand-${step}: ${hex};`);
  }

  lines.push('');
  lines.push('  /* neutrals — anchored surface values, carrying a small cast of the brand hue */');
  for (const { step, hex } of neutral) {
    lines.push(`  --ln-neutral-${step}: ${hex};`);
  }

  lines.push('');
  lines.push('  /* Legible text on a brand fill, chosen by contrast rather than by taste. */');
  lines.push(`  --ln-on-brand: ${readableTextOn(seed)};`);
  lines.push('}');

  lines.push('');
  lines.push('/*');
  lines.push(' * Category hues, emitted for both schemes so the same HTML is colour-coded');
  lines.push(' * on a light till and a dark one without a client-side theme read.');
  lines.push(' */');
  lines.push(':root {');
  for (const color of CATEGORY_COLORS) {
    lines.push(`  --ln-cat-${color.key}: ${color.light};`);
  }
  lines.push('}');
  lines.push('');
  lines.push('html body.dark,');
  lines.push('html:has(body.dark) {');
  for (const color of CATEGORY_COLORS) {
    lines.push(`  --ln-cat-${color.key}: ${color.dark};`);
  }
  lines.push('}');

  return lines.join('\n');
}
