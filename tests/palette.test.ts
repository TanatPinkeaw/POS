import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BRAND_ANCHORS, BRAND_SEED, THEME_COLOR } from '@/brand/brand';
import { contrastRatio, relativeLuminance } from '@/lib/color';
import {
  BRAND_ANCHOR_STEPS,
  buildBrandRamp,
  buildNeutralRamp,
  NEUTRAL_STEPS,
  primaryAnchor,
  renderRampBlock,
  SEED_STEP,
} from '@/lib/palette';

const HEX = /^#[0-9a-f]{6}$/;

const PRIMARY = primaryAnchor(BRAND_ANCHORS);

describe('buildBrandRamp', () => {
  const ramp = buildBrandRamp(BRAND_ANCHORS);

  it('covers the ten steps a design system expects', () => {
    expect(ramp.map((entry) => entry.step)).toEqual([
      50, 100, 200, 300, 400, 500, 600, 700, 800, 900,
    ]);
  });

  it('reproduces every chosen anchor verbatim, at its own step', () => {
    // The property that makes a rebrand an edit to one list: the anchors are not
    // approximated by the ramp, they *are* steps of it — all seven of them.
    for (const [index, hex] of BRAND_ANCHORS.entries()) {
      expect(ramp.find((entry) => entry.step === BRAND_ANCHOR_STEPS[index])?.hex).toBe(hex);
    }
  });

  it('puts the primary anchor at step 600', () => {
    expect(ramp.find((entry) => entry.step === SEED_STEP)?.hex).toBe(PRIMARY);
    expect(BRAND_SEED).toBe(PRIMARY);
  });

  it('refuses an anchor list of the wrong length', () => {
    // A ramp with four colours in it would silently produce undefined steps.
    expect(() => buildBrandRamp(BRAND_ANCHORS.slice(0, 4))).toThrow(/Expected 7 brand anchors/);
  });

  it('steps monotonically darker, so no two steps are the same colour', () => {
    const luminances = ramp.map((entry) => relativeLuminance(entry.hex));
    for (let index = 1; index < luminances.length; index += 1) {
      expect(luminances[index]!).toBeLessThan(luminances[index - 1]!);
    }
  });

  it('produces only valid hex', () => {
    for (const entry of ramp) {
      expect(entry.hex).toMatch(HEX);
    }
  });

  it('keeps the primary legible as text on white', () => {
    // 600 is what `--ln-brand` points at, so it is used both as the colour of a
    // link on a white card and as the background of a primary button. The second
    // reading (white text *on* the primary) is the same contrast ratio, because
    // the ratio is symmetric. This is the constraint that decides *which* anchor 
    // can be the primary at all: of the seven, only the deepest one clears AA on a
    // white card.
    expect(contrastRatio(PRIMARY, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('gives dark mode a lighter brand step rather than reusing the primary', () => {
    // tokens.css sets `--ln-brand: var(--ln-brand-300)` under `body.dark`, for the
    // surface #171a2b. This asserts that choice is an improvement, not a habit:
    // the primary itself is too dark to read on a dark surface.
    const darkSurface = '#171a2b';
    const three = ramp.find((entry) => entry.step === 300)?.hex ?? '';
    expect(contrastRatio(three, darkSurface)).toBeGreaterThan(
      contrastRatio(PRIMARY, darkSurface),
    );
  });
});

describe('buildNeutralRamp', () => {
  const ramp = buildNeutralRamp(PRIMARY);

  it('covers every declared step', () => {
    expect(ramp.map((entry) => entry.step)).toEqual([...NEUTRAL_STEPS]);
  });

  it('runs light to dark without repeating', () => {
    const luminances = ramp.map((entry) => relativeLuminance(entry.hex));
    for (let index = 1; index < luminances.length; index += 1) {
      expect(luminances[index]!).toBeLessThan(luminances[index - 1]!);
    }
    expect(luminances[0]!).toBeGreaterThan(0.9);
    expect(luminances[luminances.length - 1]!).toBeLessThan(0.02);
  });

  it('is a near-grey, not a tint of the brand', () => {
    // The cast is deliberately small: a neutral that reads as "blue" makes the
    // whole interface look like a theme rather than a design.
    for (const entry of ramp) {
      const { r, g, b } = { r: entry.hex.slice(1, 3), g: entry.hex.slice(3, 5), b: entry.hex.slice(5, 7) };
      const spread = Math.max(
        Number.parseInt(r, 16),
        Number.parseInt(g, 16),
        Number.parseInt(b, 16),
      ) - Math.min(Number.parseInt(r, 16), Number.parseInt(g, 16), Number.parseInt(b, 16));
      expect(spread).toBeLessThan(30);
    }
  });
});

describe('renderRampBlock', () => {
  const block = renderRampBlock(BRAND_ANCHORS);

  it('is deterministic, so a regenerated file produces no diff', () => {
    expect(renderRampBlock(BRAND_ANCHORS)).toBe(block);
  });

  it('emits exactly one declaration per brand and neutral step, plus on-brand', () => {
    expect(block.match(/--ln-brand-(50|100|200|300|400|500|600|700|800|900):/g)).toHaveLength(10);
    expect(block.match(/--ln-neutral-\d+:/g)).toHaveLength(NEUTRAL_STEPS.length);
    expect(block.match(/--ln-on-brand:/g)).toHaveLength(1);
  });

  it('carries no Bootstrap-era token, so nothing outlives the bridge', () => {
    // `--ln-brand-rgb` existed only so the vendored theme's `rgba(var(--x), 0.2)`
    // form could be bridged. The theme is gone (ADR 0003), so a bare RGB triple
    // reappearing here would be a token with no consumer.
    expect(block).not.toContain('--ln-brand-rgb');
  });

  it('warns that it is generated', () => {
    expect(block).toContain('GENERATED');
  });
});

describe('the installed-app manifest', () => {
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as {
    theme_color?: string;
  };

  it('paints the browser chrome in the colour the app declares for it', () => {
    // Two files declare the theme colour — `metadata.themeColor`, which comes from
    // THEME_COLOR, and the manifest the OS reads, which is hand-written — and only
    // one of them is generated. Without this, a rebrand ships a phone in the old
    // colour, which is a drift nothing else in the suite would catch.
    expect(manifest.theme_color?.toLowerCase()).toBe(THEME_COLOR.light);
  });
});
