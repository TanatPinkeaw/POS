/**
 * Contrast, read from the stylesheet that actually ships.
 *
 * Every other test in this suite checks a module. This one checks
 * `src/design/tokens.css` by parsing it, resolving `var()` chains and alpha
 * compositing, and asserting that the colour pairs the design system promises are
 * legible in both schemes. The point is not to re-state the values — it is to
 * catch the one edit that silently breaks legibility: someone darkens a surface,
 * lightens a muted text step, or repoints `--ln-text-subtle` at a lighter neutral
 * to make a screenshot look tidier.
 *
 * Reading the file rather than a copy of its values is what makes that work. A
 * copied table would pass while the shipped stylesheet failed.
 *
 * The second half of the file asks the complementary question: not "is this pair
 * legible" but "are these two colours *different*" — a status must not look like
 * the brand, and the nine aisle colours must not look like each other.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { contrastRatio, deltaE, mix, relativeLuminance } from '@/lib/color';

const TOKENS_PATH = 'src/design/tokens.css';

/** The weight of a category chip's tint. Mirrored from `Value.module.css`. */
const CATEGORY_TINT = 0.14;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

type TokenMap = Map<string, string>;

/**
 * Splits the stylesheet into declarations per scheme.
 *
 * Only two buckets are needed, because the file has exactly two: everything that
 * paints the light UI (the ramp, the semantic block, both density blocks) and
 * everything under `.dark`. Density blocks redeclare sizes, never colours, so
 * merging them into the light bucket costs nothing and means a colour that moves
 * *into* a density block would still be picked up.
 */
function readTokens(source: string): { light: TokenMap; dark: TokenMap } {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const light: TokenMap = new Map();
  const dark: TokenMap = new Map();

  let selectors: string[] = [];
  let buffer = '';
  let declarations: Array<[string, string]> = [];

  for (const character of clean) {
    if (character === '{') {
      selectors = buffer
        .split(',')
        .map((selector) => selector.trim())
        .filter(Boolean);
      buffer = '';
      continue;
    }

    if (character === '}') {
      for (const selector of selectors) {
        const target = selector.includes('dark') ? dark : light;
        for (const [name, value] of declarations) {
          target.set(name, value);
        }
      }
      selectors = [];
      declarations = [];
      buffer = '';
      continue;
    }

    if (character === ';') {
      const separator = buffer.indexOf(':');
      if (separator > 0 && buffer.trimStart().startsWith('--')) {
        declarations.push([
          buffer.slice(0, separator).trim(),
          buffer.slice(separator + 1).trim(),
        ]);
      }
      buffer = '';
      continue;
    }

    buffer += character;
  }

  // Dark mode *inherits* the ramp: `--ln-brand-400` is declared once, on `:root`,
  // and the dark block only repoints the semantic names at it. So the dark map is
  // the light map with the dark overrides laid on top — which is also what the
  // browser does, and means a token that only exists in one scheme still resolves.
  return { light, dark: new Map([...light, ...dark]) };
}

/** `#rgb`, `#rrggbb`, `rgb(r, g, b)` and `rgba(r, g, b, a)`. */
function parseColor(value: string): Rgba | null {
  const text = value.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits =
      hex[1]!.length === 3
        ? hex[1]!
            .split('')
            .map((character) => character + character)
            .join('')
        : hex[1]!;
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }

  const functional = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (functional) {
    const parts = functional[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) {
      return {
        r: parts[0]!,
        g: parts[1]!,
        b: parts[2]!,
        a: parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3]! : 1,
      };
    }
  }

  return null;
}

/**
 * Resolves a token to a colour, following `var()` and the one `color-mix` form
 * this design system uses.
 *
 * `color-mix(in srgb, C 16%, transparent)` is how a dark-mode soft fill is
 * written, and CSS mixes alpha premultiplied — so `C` at 16 % alpha is exactly
 * what the browser paints. Handling that one form keeps the test honest instead
 * of skipping half of dark mode.
 */
function resolve(name: string, tokens: TokenMap, depth = 0): Rgba | null {
  if (depth > 8) {
    return null;
  }

  const raw = tokens.get(name);
  if (!raw) {
    return null;
  }

  const value = raw.trim();

  const variable = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
  if (variable) {
    return resolve(variable[1]!, tokens, depth + 1);
  }

  const mixed = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/i.exec(
    value,
  );
  if (mixed) {
    const base = resolveColorExpression(mixed[1]!, tokens, depth + 1);
    if (!base) {
      return null;
    }
    return { ...base, a: (base.a * Number(mixed[2]!)) / 100 };
  }

  return resolveColorExpression(value, tokens, depth);
}

function resolveColorExpression(
  value: string,
  tokens: TokenMap,
  depth: number,
): Rgba | null {
  const direct = parseColor(value);
  if (direct) {
    return direct;
  }

  const variable = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (variable) {
    return resolve(variable[1]!, tokens, depth + 1);
  }

  return null;
}

/** Flattens a translucent colour onto an opaque one, as the browser paints it. */
function over(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) {
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  const blend = (front: number, back: number): number =>
    (front * foreground.a + back * background.a * (1 - foreground.a)) / alpha;
  return {
    r: blend(foreground.r, background.r),
    g: blend(foreground.g, background.g),
    b: blend(foreground.b, background.b),
    a: 1,
  };
}

function toHex({ r, g, b }: Rgba): string {
  const channel = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

const source = readFileSync(TOKENS_PATH, 'utf8');
const tokens = readTokens(source);

/** A token that must resolve, or the test is asserting nothing. */
function color(scheme: 'light' | 'dark', name: string): string {
  const resolved = resolve(name, tokens[scheme]);
  if (!resolved) {
    throw new Error(`${name} does not resolve in ${scheme} mode (check ${TOKENS_PATH})`);
  }
  return toHex(resolved);
}

/** A token floored over a surface, which is how a soft chip actually renders. */
function overSurface(scheme: 'light' | 'dark', name: string, surface: string): string {
  const resolved = resolve(name, tokens[scheme]);
  if (!resolved) {
    throw new Error(`${name} does not resolve in ${scheme} mode`);
  }
  const base = resolve(surface, tokens[scheme]);
  if (!base) {
    throw new Error(`${surface} does not resolve in ${scheme} mode`);
  }
  return toHex(over(resolved, base));
}

/**
 * Every pair the interface promises to keep legible. Text pairs must clear AA for
 * body text (4.5), because 14 px muted text is body text — a comment, a hint, a
 * unit beside an amount — and not decoration.
 */
const TEXT_ON = ['--ln-surface', '--ln-canvas'] as const;
const TEXT_TOKENS = [
  '--ln-text',
  '--ln-text-muted',
  '--ln-text-subtle',
  '--ln-brand',
  '--ln-success',
  '--ln-warning',
  '--ln-danger',
  '--ln-info',
] as const;

const SOFT_PAIRS = [
  ['--ln-brand', '--ln-brand-soft'],
  ['--ln-success', '--ln-success-soft'],
  ['--ln-warning', '--ln-warning-soft'],
  ['--ln-danger', '--ln-danger-soft'],
  ['--ln-info', '--ln-info-soft'],
] as const;

const CATEGORY_KEYS = [
  'slate',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'rose',
  'violet',
] as const;

describe.each(['light', 'dark'] as const)('tokens.css contrast (%s)', (scheme) => {
  it('resolves the tokens it is asked about', () => {
    // A parse failure would turn every assertion below into a vacuous pass.
    expect(tokens[scheme].size).toBeGreaterThan(20);
    expect(color(scheme, '--ln-text')).toMatch(/^#[0-9a-f]{6}$/);
    expect(color(scheme, '--ln-canvas')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(TEXT_ON)('keeps every text token legible on %s', (surface) => {
    for (const token of TEXT_TOKENS) {
      const ratio = contrastRatio(color(scheme, token), color(scheme, surface));
      expect(
        ratio,
        `${token} on ${surface} is ${ratio.toFixed(2)}:1 in ${scheme} mode`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps white on the brand fill legible', () => {
    const ratio = contrastRatio(color(scheme, '--ln-on-brand'), color(scheme, '--ln-brand'));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SOFT_PAIRS)('keeps %s legible on its own soft fill (%s)', (foreground, soft) => {
    const ratio = contrastRatio(
      color(scheme, foreground),
      overSurface(scheme, soft, '--ln-surface'),
    );
    expect(
      ratio,
      `${foreground} on ${soft} is ${ratio.toFixed(2)}:1 in ${scheme} mode`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps all nine category hues legible as chip text', () => {
    for (const key of CATEGORY_KEYS) {
      const name = `--ln-cat-${key}`;
      const foreground = color(scheme, name);

      const onSurface = contrastRatio(foreground, color(scheme, '--ln-surface'));
      expect(onSurface, `${name} on surface is ${onSurface.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );

      //
      // The chip's own tint, at the 14 % the pill component uses. The category
      // token is opaque, so the tint has to be mixed here rather than composited —
      // that is exactly what `color-mix(in srgb, var(--ln-cat-x) 14%, surface)`
      // does in the component, and mixing it the same way is what makes this test
      // about the real chip rather than about an imaginary translucent one.
      const tinted = mix(foreground, color(scheme, '--ln-surface'), 1 - CATEGORY_TINT);
      const onTint = contrastRatio(foreground, tinted);
      expect(onTint, `${name} on its tint is ${onTint.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('separates a hairline border from the surface it draws on', () => {
    // A border that fails this is invisible; one that overshoots turns every card
    // into a box drawing. The band is wide on purpose — it is a sanity check on
    // the neutral ramp, not a WCAG requirement.
    const ratio = contrastRatio(color(scheme, '--ln-border'), color(scheme, '--ln-surface'));
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(3);
  });

  it('draws the focus ring strongly enough to be seen on the canvas', () => {
    // 3:1 is WCAG 2.2's requirement for a focus indicator, and the ring is the
    // only affordance a keyboard user gets on a 32 px target.
    const ratio = contrastRatio(color(scheme, '--ln-brand'), color(scheme, '--ln-canvas'));
    expect(ratio, `focus ring on canvas is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
  });
});

/**
 * A colour is "clear of" another when the difference is past the point where the
 * eye reads them as one colour. CIE76 ΔE 20 is that line: an order of magnitude
 * above the just-noticeable difference, and where the palette audit found the
 * failures it was written to catch — the two worst were ΔE 7 and ΔE 14, a status
 * chip and a brand chip painted the same colour on a dark till.
 *
 * The tighter floor for statuses between themselves (25) is deliberate: two status
 * chips sit inches apart in the same list, so they have to be told apart at a
 * glance rather than from memory.
 */
const CLEAR_OF_BRAND = 20;
const CLEAR_OF_EACH_OTHER = { status: 25, category: 15 } as const;

const BRAND_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
const STATUS_KEYS = ['success', 'warning', 'danger', 'info'] as const;

describe.each(['light', 'dark'] as const)('brand separation (%s)', (scheme) => {
  const brand = BRAND_STEPS.map((step) => ({
    step,
    hex: color(scheme, `--ln-brand-${step}`),
  }));

  const roles = [
    ...STATUS_KEYS.map((key) => ({ role: 'status' as const, key, hex: color(scheme, `--ln-${key}`) })),
    ...CATEGORY_KEYS.map((key) => ({ role: 'category' as const, key, hex: color(scheme, `--ln-cat-${key}`) })),
  ];

  it('keeps every status and category colour clear of every brand step', () => {
    // The brand is a warm sweep from olive to salmon, which is exactly where a
    // warning, a danger and a success all want to live. This is the assertion that
    // keeps them apart — without it, a rebrand silently flattens the two together
    // and nothing else in the suite notices.
    for (const { role, key, hex } of roles) {
      for (const step of brand) {
        const distance = deltaE(hex, step.hex);
        expect(
          distance,
          `${role} ${key} (${hex}) vs brand-${step.step} (${step.hex}) is ΔE ${distance.toFixed(1)} in ${scheme} mode`,
        ).toBeGreaterThanOrEqual(CLEAR_OF_BRAND);
      }
    }
  });

  it('keeps the four statuses clear of each other', () => {
    for (let i = 0; i < STATUS_KEYS.length; i += 1) {
      for (let j = i + 1; j < STATUS_KEYS.length; j += 1) {
        const first = color(scheme, `--ln-${STATUS_KEYS[i]!}`);
        const second = color(scheme, `--ln-${STATUS_KEYS[j]!}`);
        const distance = deltaE(first, second);
        expect(
          distance,
          `${STATUS_KEYS[i]} and ${STATUS_KEYS[j]} are ΔE ${distance.toFixed(1)} in ${scheme} mode`,
        ).toBeGreaterThanOrEqual(CLEAR_OF_EACH_OTHER.status);
      }
    }
  });

  it('keeps the nine aisle colours clear of each other', () => {
    // A shop with nine categories should not end up with two aisles that look
    // alike — the whole point of colour-coding them is peripheral recognition.
    for (let i = 0; i < CATEGORY_KEYS.length; i += 1) {
      for (let j = i + 1; j < CATEGORY_KEYS.length; j += 1) {
        const first = color(scheme, `--ln-cat-${CATEGORY_KEYS[i]!}`);
        const second = color(scheme, `--ln-cat-${CATEGORY_KEYS[j]!}`);
        const distance = deltaE(first, second);
        expect(
          distance,
          `${CATEGORY_KEYS[i]} and ${CATEGORY_KEYS[j]} are ΔE ${distance.toFixed(1)} in ${scheme} mode`,
        ).toBeGreaterThanOrEqual(CLEAR_OF_EACH_OTHER.category);
      }
    }
  });
});

describe('brand states', () => {
  const steps = ['--ln-brand', '--ln-brand-hover', '--ln-brand-active'] as const;

  it('darkens on hover in light mode and lightens in dark mode, never the reverse', () => {
    // The direction is what matters, not the size: many palettes put a hover step a
    // hair away from its resting step, and one that lands on the *other* side of it
    // reads as a rendering fault rather than as feedback. The brand swap made this
    // reachable, because the ramp's 200 and 300 steps are the same lightness to the
    // eye while still being ordered by WCAG luminance.
    const light = steps.map((name) => relativeLuminance(color('light', name)));
    for (let index = 1; index < light.length; index += 1) {
      expect(light[index]!, `${steps[index]} is not darker than ${steps[index - 1]}`).toBeLessThan(
        light[index - 1]!,
      );
    }

    const dark = steps.map((name) => relativeLuminance(color('dark', name)));
    for (let index = 1; index < dark.length; index += 1) {
      expect(dark[index]!, `${steps[index]} is not lighter than ${steps[index - 1]}`).toBeGreaterThan(
        dark[index - 1]!,
      );
    }
  });
});

describe('density tokens', () => {
  const compact = readTokens(source).light;

  it('keeps compact leading above the floor Thai needs', () => {
    const leading = Number.parseFloat(compact.get('--ln-leading') ?? '0');
    expect(leading).toBeGreaterThanOrEqual(1.5);
  });

  it('keeps the touch target of a till at 44px or more', () => {
    // Regression guard on the one number the reference design is explicit about:
    // an operator's hands are wet, and a 34 px button is a mis-tap.
    const touch = source.slice(source.indexOf("[data-density='touch']"));
    const tap = Number.parseFloat(/--ln-tap:\s*(\d+)px/.exec(touch)?.[1] ?? '0');
    expect(tap).toBeGreaterThanOrEqual(44);
  });
});
