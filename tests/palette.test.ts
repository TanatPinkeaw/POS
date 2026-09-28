import { describe, expect, it } from 'vitest';

import { BRAND_SEED } from '@/brand/brand';
import { contrastRatio, hexToRgb, relativeLuminance } from '@/lib/color';
import {
  buildBrandRamp,
  buildNeutralRamp,
  NEUTRAL_STEPS,
  renderRampBlock,
  SEED_STEP,
} from '@/lib/palette';

const HEX = /^#[0-9a-f]{6}$/;

describe('buildBrandRamp', () => {
  const ramp = buildBrandRamp(BRAND_SEED);

  it('covers the ten steps a design system expects', () => {
    expect(ramp.map((entry) => entry.step)).toEqual([
      50, 100, 200, 300, 400, 500, 600, 700, 800, 900,
    ]);
  });

  it('reproduces the seed verbatim at step 600', () => {
    // The property that makes "change the brand" a one-line change: the seed is
    // not approximated by the ramp, it *is* a step of it.
    expect(ramp.find((entry) => entry.step === SEED_STEP)?.hex).toBe(BRAND_SEED);
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

  it('keeps the seed legible as text on white', () => {
    // 600 is what `--ln-brand` points at, so it is used both as the colour of a
    // link on a white card and as the background of a primary button. The second
    // reading (white text *on* the seed) is the same contrast ratio, because the
    // ratio is symmetric.
    expect(contrastRatio(BRAND_SEED, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('gives dark mode a lighter brand step rather than reusing the seed', () => {
    // tokens.css sets `--ln-brand: var(--ln-brand-400)` under `body.dark`, for the
    // surface #171a2b. This asserts that choice is an improvement, not a habit:
    // the seed itself would be too dark to read on a dark surface.
    const darkSurface = '#171a2b';
    const four = ramp.find((entry) => entry.step === 400)?.hex ?? '';
    expect(contrastRatio(four, darkSurface)).toBeGreaterThan(
      contrastRatio(BRAND_SEED, darkSurface),
    );
  });
});

describe('buildNeutralRamp', () => {
  const ramp = buildNeutralRamp(BRAND_SEED);

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
  const block = renderRampBlock(BRAND_SEED);

  it('is deterministic, so a regenerated file produces no diff', () => {
    expect(renderRampBlock(BRAND_SEED)).toBe(block);
  });

  it('emits exactly one declaration per brand and neutral step, plus on-brand', () => {
    expect(block.match(/--ln-brand-(50|100|200|300|400|500|600|700|800|900):/g)).toHaveLength(10);
    expect(block.match(/--ln-neutral-\d+:/g)).toHaveLength(NEUTRAL_STEPS.length);
    expect(block.match(/--ln-on-brand:/g)).toHaveLength(1);
  });

  it('publishes the seed as bare RGB channels, matching the ramp', () => {
    // The Bootstrap-era bridge needs `r, g, b` for its `rgba(var(--x), 0.2)` form.
    // Hardcoding that triple next to a generated ramp is exactly how a rebrand
    // ends up half-applied, so it is generated from the same seed.
    const { r, g, b } = hexToRgb(BRAND_SEED);
    expect(block).toContain(`--ln-brand-rgb: ${r}, ${g}, ${b};`);
  });

  it('warns that it is generated', () => {
    expect(block).toContain('GENERATED');
  });
});
