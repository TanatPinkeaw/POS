/**
 * Resamples the brand mark into the PNG app icons — `npm run brand:icons`.
 *
 * The mark is a committed PNG (`MARK.file`) rather than geometry in this repository,
 * because it is a shaded illustration: a screen with the letter drawn on it in a light
 * tone, which a one-colour vector trace flattens into a silhouette with the letter
 * missing (ADR 0015). So this script is a **resampler** — source pixels in, icon pixels
 * out — and not a renderer, which is why the small SVG path parser and the
 * point-in-polygon fill that used to be the bulk of this file are gone. Nothing here
 * knows what the mark looks like.
 *
 * The arithmetic lives in `src/lib/mark-image.ts` and this is only its driver: read the
 * artwork, walk the icon table, write the bytes. That split is the same one
 * `scripts/brand-palette.ts` keeps with `src/lib/palette.ts`, and for the same reason —
 * a wrong answer here produces a picture that looks *plausible*, so the maths needs to
 * be testable without writing files into `public/`.
 *
 * What that leaves the script to decide, and why each one is here rather than in the
 * library:
 *
 *   * **Which icons exist.** Five files, four of them what a browser or an installer
 *     asks for by name, and each with its own plate: rounded for the tab and the
 *     manifest, full-bleed for iOS and the maskable variant, because those two are
 *     masked by the platform.
 *   * **The ground.** The palette's lightest step, because the artwork's ink is a deep
 *     olive: the icons this replaced were a white mark knocked out of the brand's
 *     darkest step, which worked only because that mark was one colour.
 *   * **No generated SVG.** A raster cannot be one, and a second, flatter vector
 *     drawing of the mark is exactly what ADR 0015 rejects, so `public/icon.svg` is not
 *     written and no longer exists. Browsers that ask for `/favicon.ico` still get it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { BRAND_ANCHORS, MARK } from '../src/brand/brand';
import { hexToRgb } from '../src/lib/color';
import { contentBox, decodePng, encodePng, renderIcon, wrapIco } from '../src/lib/mark-image';

interface IconSpec {
  file: string;
  /** Edge length in pixels. */
  size: number;
  /** Plate corner radius, as a fraction of the edge. */
  radius: number;
  /** Full-bleed square plate: iOS and Android's maskable icons both mask it. */
  bleed: boolean;
  /** Wrap the raster in an `.ico` container instead of writing a bare PNG. */
  ico?: boolean;
}

const ICONS: IconSpec[] = [
  { file: 'public/icon-192.png', size: 192, radius: 0.225, bleed: false },
  { file: 'public/icon-512.png', size: 512, radius: 0.225, bleed: false },
  { file: 'public/apple-touch-icon.png', size: 180, radius: 0, bleed: true },
  { file: 'public/icon-maskable-512.png', size: 512, radius: 0, bleed: true },
  // Browsers, bookmarks and crawlers ask for /favicon.ico whether or not a page
  // declares an icon, and answering a 404 to that is a pointless console error.
  { file: 'public/favicon.ico', size: 48, radius: 0.225, bleed: false, ico: true },
];

/**
 * Renders pixels as text, so a regenerated icon can be checked without an image
 * viewer — which is exactly the step people skip.
 *
 * The plate reads `#` and the ink reads `.`/`o`, the inverse of the white-on-olive
 * icons this replaced, because the artwork is dark on a light ground.
 */
function ascii(rgba: Buffer, size: number, columns = 40): string {
  const rows: string[] = [];
  for (let row = 0; row < columns; row += 1) {
    let line = '';
    for (let column = 0; column < columns; column += 1) {
      const x = Math.floor(((column + 0.5) * size) / columns);
      const y = Math.floor(((row + 0.5) * size) / columns);
      const offset = (y * size + x) * 4;
      if ((rgba[offset + 3] as number) < 40) {
        line += ' ';
        continue;
      }
      const luminance =
        ((rgba[offset] as number) + (rgba[offset + 1] as number) + (rgba[offset + 2] as number)) / 3;
      line += luminance > 200 ? '#' : luminance > 140 ? '+' : luminance > 70 ? 'o' : '.';
    }
    rows.push(line);
  }
  return rows.join('\n');
}

function main(): void {
  const preview = process.argv.includes('--preview');
  const art = decodePng(readFileSync(MARK.file));
  const box = contentBox(art);
  const plateHex = BRAND_ANCHORS[0];
  const plate = hexToRgb(plateHex);

  console.log(
    `brand icons: ${MARK.file} ${art.width}×${art.height}, ` +
      `artwork ${box.width}×${box.height} at ${box.x},${box.y}, on ${plateHex}`,
  );

  for (const spec of ICONS) {
    const png = encodePng(spec.size, renderIcon(spec, art, plate));
    const output = spec.ico ? wrapIco(png, spec.size) : png;
    writeFileSync(spec.file, output);
    console.log(
      `  • ${spec.file.padEnd(34)} ${spec.size}×${spec.size}  ${(output.length / 1024).toFixed(1)} kB` +
        `${spec.bleed ? '  (full-bleed)' : ''}${spec.ico ? '  (ico container)' : ''}`,
    );
  }

  if (preview) {
    for (const spec of ICONS) {
      if (spec.ico) {
        continue;
      }
      const written = decodePng(readFileSync(spec.file));
      console.log(`\n${spec.file} (${written.width}×${written.height})`);
      console.log(ascii(written.rgba, written.width));
    }
  }

  console.log('  rerun after replacing the artwork: npm run brand:icons');
}

main();
