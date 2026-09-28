/**
 * Colour arithmetic — pure, dependency-free, and used by both brand generators.
 *
 * Two colour spaces, because there are two different questions:
 *
 *   * **sRGB** for *mixing*. Interpolating toward white or black in linear light
 *     compresses the dark end badly — an 91 % mix toward black lands on a
 *     mid-grey — so a ramp built that way has a "900" step that is too light to
 *     use as body text. sRGB interpolation gives the evenly-perceived ramp that
 *     every Tailwind- or Bootstrap-shaped eye already expects.
 *   * **linear light** for *luminance*. Contrast is a physical quantity; WCAG's
 *     ratio is only meaningful computed from linearised channels.
 *
 * Keeping both here, instead of a helper inside each script, is what lets the
 * palette be unit-tested without writing a CSS file.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses `#rgb` or `#rrggbb`. Throws rather than returning a wrong colour. */
export function hexToRgb(hex: string): Rgb {
  const value = hex.trim().replace(/^#/, '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((character) => character + character)
          .join('')
      : value;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: ${hex}`);
  }

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number): string =>
    Math.round(Math.min(255, Math.max(0, value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Mixes `weight` of `b` into `a`, in sRGB. `weight` 0 returns `a` exactly, so a
 * ramp anchored on the seed reproduces it byte for byte.
 */
export function mix(a: string, b: string, weight: number): string {
  const left = hexToRgb(a);
  const right = hexToRgb(b);
  return rgbToHex({
    r: left.r + (right.r - left.r) * weight,
    g: left.g + (right.g - left.g) * weight,
    b: left.b + (right.b - left.b) * weight,
  });
}

/** sRGB transfer function. Used for luminance only, never for mixing. */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/* ------------------------------------------------------------------ distance */

/** CIE L*a*b*, the space colour *differences* are measured in. */
export interface Lab {
  /** Lightness, 0 (black) to 100 (white). */
  l: number;
  /** Green to red. */
  a: number;
  /** Blue to yellow. */
  b: number;
}

/* D65, the white point sRGB is defined against. */
const WHITE_POINT = { x: 0.95047, y: 1, z: 1.08883 };
const EPSILON = 216 / 24389;
const KAPPA = 24389 / 27;

/** sRGB → CIE L*a*b*. */
export function lab(hex: string): Lab {
  const { r, g, b } = hexToRgb(hex);
  const linear = [toLinear(r), toLinear(g), toLinear(b)] as const;

  const x = (0.4124564 * linear[0] + 0.3575761 * linear[1] + 0.1804375 * linear[2]) / WHITE_POINT.x;
  const y = (0.2126729 * linear[0] + 0.7151522 * linear[1] + 0.0721750 * linear[2]) / WHITE_POINT.y;
  const z = (0.0193339 * linear[0] + 0.1191920 * linear[1] + 0.9503041 * linear[2]) / WHITE_POINT.z;

  const f = (value: number): number =>
    value > EPSILON ? Math.cbrt(value) : (KAPPA * value + 16) / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIE76 colour difference. Roughly: under 2 is invisible, 2–10 is a shade of the
 * same colour, 10–20 is a clearly different colour, over 20 is a different colour
 * family.
 *
 * CIE76 rather than CIEDE2000 because the question asked here is blunt — *is a
 * status colour confusable with the brand at a glance, on a counter, through a
 * cheap panel?* — and the older formula answers it with a tenth of the code. The
 * thresholds the design system asserts are set with that slack in mind.
 */
export function deltaE(a: string, b: string): number {
  const first = lab(a);
  const second = lab(b);
  return Math.hypot(first.l - second.l, first.a - second.a, first.b - second.b);
}

/**
 * The text colour to use on a filled surface, chosen by contrast rather than by
 * taste. `#0b0c12` is the project's ink rather than pure black, which is harsh
 * against a saturated fill on a lit screen.
 */
export function readableTextOn(background: string, ink = '#0b0c12'): string {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, ink)
    ? '#ffffff'
    : ink;
}
