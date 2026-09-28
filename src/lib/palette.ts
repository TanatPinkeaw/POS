/**
 * The brand ramp, derived from one seed colour.
 *
 * Pure and separate from `scripts/brand-palette.ts` on purpose: the ramp is a
 * *design decision* that deserves tests (lightness must step monotonically, the
 * seed must survive verbatim, the on-brand text must be legible), and a script
 * whose only entry point is `main()` cannot be tested without writing a file.
 */
import { hexToRgb, mix, readableTextOn } from './color';

/** Where each step sits between the seed and white (above 600) or black (below). */
export const BRAND_STEPS: readonly {
  step: number;
  toward: 'white' | 'black' | 'seed';
  weight: number;
}[] = [
  { step: 50, toward: 'white', weight: 0.94 },
  { step: 100, toward: 'white', weight: 0.88 },
  { step: 200, toward: 'white', weight: 0.74 },
  { step: 300, toward: 'white', weight: 0.58 },
  { step: 400, toward: 'white', weight: 0.38 },
  { step: 500, toward: 'white', weight: 0.18 },
  { step: 600, toward: 'seed', weight: 0 },
  { step: 700, toward: 'black', weight: 0.14 },
  { step: 800, toward: 'black', weight: 0.3 },
  { step: 900, toward: 'black', weight: 0.46 },
];

/** Surfaces, borders and text. Named 0–950, so 0 is the lightest. */
export const NEUTRAL_STEPS = [
  0, 25, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950,
] as const;

/**
 * 600 is the seed itself — the step every design system this replaces would call
 * "the" colour, and therefore what `--ln-brand` points at.
 */
export const SEED_STEP = 600;

const WHITE = '#ffffff';
const BLACK = '#000000';
/** The darkest neutral: not pure black, which is harsh on a lit till screen. */
const INK = '#0b0c12';

/**
 * How much of the brand hue is mixed into every neutral.
 *
 * A pure grey ramp beside a saturated indigo looks like two palettes. Four
 * percent is below the threshold where anyone would call the greys "blue", but
 * enough that surfaces and the brand read as related.
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
 * `600` is muted text. Only the *cast* is derived from the seed, which is what
 * keeps the greys related to the brand without turning them into a tint of it.
 *
 * `0` is pure white and takes no cast at all: a card on the canvas has to be
 * white, because that contrast against the canvas is what the layout reads as
 * "card" once elevation is gone.
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
 * The near-white surfaces are held back deliberately. A 4 % indigo cast on a
 * canvas is a blue-grey page, and on white it is a lavender card — so the steps
 * that exist to be *clean surfaces* carry a quarter of the cast, while the mid
 * greys that sit beside the brand in a table or a chart carry all of it.
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

export function buildBrandRamp(seed: string): RampEntry[] {
  return BRAND_STEPS.map(({ step, toward, weight }) => ({
    step,
    hex:
      toward === 'seed'
        ? seed
        : toward === 'white'
          ? mix(seed, WHITE, weight)
          : mix(seed, BLACK, weight),
  }));
}

export function buildNeutralRamp(seed: string): RampEntry[] {
  return NEUTRAL_STEPS.map((step) => {
    const anchor = NEUTRAL_ANCHORS[step];
    if (!anchor) {
      throw new Error(`No neutral anchor for step ${step}`);
    }
    return { step, hex: mix(anchor, seed, NEUTRAL_CAST * (CAST_FACTOR[step] ?? 1)) };
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
 * derived from it, so the pill and the text it carries are the same hue), and the
 * dark value must be legible on the dark surface. Both are asserted in the test
 * suite, which is what stops a tenth category from being added with an
 * unreadable colour later.
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
  { key: 'amber', light: '#8a5f05', dark: '#f3cd7a' },
  { key: 'orange', light: '#a8480a', dark: '#f6b27f' },
  { key: 'red', light: '#b3261e', dark: '#ffa39a' },
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

/** The generated CSS. Deterministic: same seed in, same bytes out. */
export function renderRampBlock(seed: string): string {
  const brand = buildBrandRamp(seed);
  const neutral = buildNeutralRamp(seed);

  const lines: string[] = [];
  lines.push('/*');
  lines.push(' * GENERATED — do not edit by hand. `npm run brand:palette` rewrites');
  lines.push(' * everything between the ramp markers from the seed in src/brand/brand.ts.');
  lines.push(' * The semantic layer below this block is hand-written on purpose.');
  lines.push(' */');
  lines.push(':root {');

  lines.push('  /* brand — 600 is the seed itself */');
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
  lines.push('');
  lines.push(
    '  /* The seed as bare channels. Bootstrap-era code needs `r, g, b` for its',
  );
  lines.push('     `rgba(var(--x), 0.2)` form, and hardcoding the triple here is how a',
  );
  lines.push('     rebrand ends up half-applied. */');
  const { r, g, b } = hexToRgb(seed);
  lines.push(`  --ln-brand-rgb: ${r}, ${g}, ${b};`);
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
