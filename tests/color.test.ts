import { describe, expect, it } from 'vitest';

import { BRAND_SEED } from '@/brand/brand';
import {
  contrastRatio,
  deltaE,
  hexToRgb,
  lab,
  mix,
  readableTextOn,
  relativeLuminance,
  rgbToHex,
} from '@/lib/color';

describe('hexToRgb', () => {
  it('reads six-digit hex', () => {
    expect(hexToRgb('#2E3BD8')).toEqual({ r: 46, g: 59, b: 216 });
  });

  it('expands three-digit shorthand', () => {
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('#08f')).toEqual({ r: 0, g: 136, b: 255 });
  });

  it('accepts a value with no hash, and with surrounding space', () => {
    expect(hexToRgb('  2e3bd8 ')).toEqual({ r: 46, g: 59, b: 216 });
  });

  it('refuses anything else rather than inventing a colour', () => {
    expect(() => hexToRgb('#12345')).toThrow();
    expect(() => hexToRgb('rebeccapurple')).toThrow();
    expect(() => hexToRgb('#gggggg')).toThrow();
  });
});

describe('rgbToHex', () => {
  it('round-trips through hexToRgb', () => {
    expect(rgbToHex(hexToRgb(BRAND_SEED))).toBe(BRAND_SEED);
  });

  it('clamps out-of-range channels instead of wrapping', () => {
    expect(rgbToHex({ r: 300, g: -20, b: 128 })).toBe('#ff0080');
  });
});

describe('mix', () => {
  it('returns the endpoints exactly at weight 0 and 1', () => {
    // Lowercase is the project's convention for every generated colour, and the
    // seed itself is lowercase for the same reason: a ramp that mixed #2E3BD8
    // with #2e3bd8 would be two spellings of one colour in one file.
    expect(mix(BRAND_SEED, '#ffffff', 0)).toBe(BRAND_SEED);
    expect(mix(BRAND_SEED, '#ffffff', 1)).toBe('#ffffff');
  });

  it('interpolates in sRGB, not in linear light', () => {
    // The whole reason for choosing this space: the midpoint of black and white
    // is mid-grey (#808080). A linear-light mix of the same endpoints lands on
    // #bcbcbc, which is what makes a ramp built that way look washed out.
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#000000', '#ffffff', 0.5)).not.toBe('#bcbcbc');
  });
});

describe('relativeLuminance', () => {
  it('is 1 for white and 0 for black', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white, the maximum', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('is symmetric', () => {
    expect(contrastRatio(BRAND_SEED, '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', BRAND_SEED),
      10,
    );
  });
});

describe('lab', () => {
  it('puts white and black at the ends of the lightness axis', () => {
    expect(lab('#ffffff').l).toBeCloseTo(100, 2);
    expect(lab('#000000').l).toBeCloseTo(0, 2);
  });

  it('matches the published value for sRGB red', () => {
    // The one colour every Lab implementation agrees on, which is what makes this
    // a check of the transform rather than of itself.
    const red = lab('#ff0000');
    expect(red.l).toBeCloseTo(53.24, 1);
    expect(red.a).toBeCloseTo(80.09, 1);
    expect(red.b).toBeCloseTo(67.2, 1);
  });

  it('is neutral on the grey axis', () => {
    const grey = lab('#808080');
    expect(grey.a).toBeCloseTo(0, 2);
    expect(grey.b).toBeCloseTo(0, 2);
  });
});

describe('deltaE', () => {
  it('is 100 between black and white, the maximum for these ends', () => {
    expect(deltaE('#000000', '#ffffff')).toBeCloseTo(100, 1);
  });

  it('is 0 for a colour against itself, and symmetric', () => {
    expect(deltaE(BRAND_SEED, BRAND_SEED)).toBe(0);
    expect(deltaE('#556b2f', '#fa8072')).toBeCloseTo(deltaE('#fa8072', '#556b2f'), 10);
  });

  it('catches a hue difference that a contrast ratio cannot see', () => {
    // Contrast is a lightness measure, and blind to hue: these two sit at almost
    // the same luminance, so the ratio says "barely a difference" while they are an
    // olive and a green — which is exactly how a status chip ends up looking like
    // the brand on a till. This is the comparison `deltaE` exists for.
    expect(contrastRatio('#556b2f', '#19794a')).toBeLessThan(2);
    expect(deltaE('#556b2f', '#19794a')).toBeGreaterThan(20);
  });
});

describe('readableTextOn', () => {
  it('picks white on the brand seed, at AA for body text', () => {
    expect(readableTextOn(BRAND_SEED)).toBe('#ffffff');
    expect(contrastRatio(BRAND_SEED, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('picks ink on a pale fill', () => {
    expect(readableTextOn('#ffe9a8')).toBe('#0b0c12');
  });
});
