/**
 * Rasterises the brand mark into the PNG app icons — `npm run brand:icons`.
 *
 * Why write a rasteriser instead of using a library or an image editor:
 *
 *   * **Regenerable.** The mark lives in `src/brand/brand.ts`. Committing four
 *     opaque PNGs means the next time the mark changes, nobody can reproduce
 *     them, and the favicon silently disagrees with the sidebar.
 *   * **No dependency.** `sharp`/`canvas` are native builds that the project has
 *     managed to avoid entirely; an icon is not the thing to break that for.
 *   * **Correct by construction.** The maskable variant needs the mark inside a
 *     10 % safe circle and *centred* on its bounding box, and the iOS icon needs
 *     a full-bleed square because iOS applies its own mask. Those are two lines
 *     of maths here and two fiddly manual crops in an editor.
 *
 * The rasteriser is deliberately small: it handles the commands the mark uses
 * (M, H, V, L, Z — all absolute), a rounded-rect plate, an antialiased stroke, and
 * a filled polygon. It is not a general SVG renderer and should not become one.
 *
 * PNG is written by hand: 8-bit RGBA (colour type 6), one `IDAT` of
 * `deflateSync`'d scanlines with filter 0, and a CRC per chunk. That is the whole
 * format for an image with no palette and no interlacing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

import { BRAND_SEED, MARK } from '../src/brand/brand';
import { hexToRgb, type Rgb } from '../src/lib/color';

type Point = { x: number; y: number };

interface IconSpec {
  file: string;
  /** Edge length in pixels. */
  size: number;
  /** Plate corner radius, in mark units (40 = the full viewBox). */
  radius: number;
  /** Full-bleed square plate: iOS and Android's maskable icons both mask it. */
  bleed: boolean;
  /** Re-centre the mark on its own bounding box (maskable safe-area rules). */
  centre: boolean;
  /** Wrap the raster in an `.ico` container instead of writing a bare PNG. */
  ico?: boolean;
}

const ICONS: IconSpec[] = [
  { file: 'public/icon-192.png', size: 192, radius: 9, bleed: false, centre: false },
  { file: 'public/icon-512.png', size: 512, radius: 9, bleed: false, centre: false },
  { file: 'public/apple-touch-icon.png', size: 180, radius: 0, bleed: true, centre: false },
  { file: 'public/icon-maskable-512.png', size: 512, radius: 0, bleed: true, centre: true },
  // Browsers, bookmarks and crawlers ask for /favicon.ico whether or not a page
  // declares an icon, and answering a 404 to that is a pointless console error.
  { file: 'public/favicon.ico', size: 48, radius: 9, bleed: false, centre: false, ico: true },
];

const VIEW = 40;
/** The stroke width of the frame, in mark units. Matches the SVG and the component. */
const STROKE = 3;

/* ------------------------------------------------------------- path parsing */

/**
 * Parses the absolute M/H/V/L/Z subset of SVG path data that the mark uses.
 *
 * Written as an index walk rather than a `for…of` over tokens, because M and L
 * each consume *two* numbers and a relative-position lookup on a token's value
 * is ambiguous the moment two coordinates are equal — which, in a symmetric
 * square, they always are.
 */
function parsePath(d: string): Point[] {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g) ?? [];
  const points: Point[] = [];
  let current: Point = { x: 0, y: 0 };
  let command = '';
  let index = 0;

  const nextNumber = (): number => {
    const value = Number(tokens[index]);
    index += 1;
    return value;
  };

  while (index < tokens.length) {
    const token = tokens[index] as string;

    if (/[A-Za-z]/.test(token)) {
      command = token.toUpperCase();
      index += 1;
      if (command === 'Z') {
        const first = points[0];
        if (first) {
          current = { ...first };
        }
        continue;
      }
    }

    switch (command) {
      case 'M':
      case 'L':
        // Only the single-pair form appears in the mark; an SVG `M` with further
        // pairs would behave as `L` and is not needed here.
        current = { x: nextNumber(), y: nextNumber() };
        points.push({ ...current });
        break;
      case 'H':
        current = { x: nextNumber(), y: current.y };
        points.push({ ...current });
        break;
      case 'V':
        current = { x: current.x, y: nextNumber() };
        points.push({ ...current });
        break;
      default:
        // A number with no command, or one this renderer does not implement:
        // skip it rather than spin.
        index += 1;
        break;
    }
  }

  return points;
}

/* ------------------------------------------------------------------ geometry */

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Even-odd point-in-polygon; the mark's shapes do not self-intersect. */
function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i] as Point;
    const b = polygon[j] as Point;
    const intersects = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/** Signed distance to a rounded rectangle centred in a `size` box. */
function roundedRectDistance(p: Point, size: number, radius: number): number {
  const half = size / 2;
  const dx = Math.abs(p.x - half) - (half - radius);
  const dy = Math.abs(p.y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function boundingBox(polygons: Point[][], stroke: number): { minX: number; minY: number; maxX: number; maxY: number } {
  const pad = stroke / 2;
  const xs = polygons.flat().map((point) => point.x);
  const ys = polygons.flat().map((point) => point.y);
  return {
    minX: Math.min(...xs) - pad,
    minY: Math.min(...ys) - pad,
    maxX: Math.max(...xs) + pad,
    maxY: Math.max(...ys) + pad,
  };
}

/* ---------------------------------------------------------------- rasteriser */

/**
 * Draws one icon and returns its raw RGBA buffer.
 *
 * Antialiasing is 4×4 supersampling rather than an analytic coverage
 * computation: the shapes include a stroked polygon, and supersampling is the
 * version of that which is obviously right rather than subtly wrong at the
 * joins. Four samples per axis is the point where a 16 px favicon stops looking
 * jagged.
 */
function renderIcon(spec: IconSpec, frame: Point[], corner: Point[], plate: Rgb): Buffer {
  const { size } = spec;
  const samples = 4;
  const sub = 1 / samples;
  const scale = size / VIEW;

  // The mark's polygons, translated into pixel space once.
  const shift = { x: 0, y: 0 };
  if (spec.centre) {
    const box = boundingBox([frame, corner], STROKE);
    shift.x = VIEW / 2 - (box.minX + box.maxX) / 2;
    shift.y = VIEW / 2 - (box.minY + box.maxY) / 2;
  }
  const toPixels = (points: Point[]): Point[] =>
    points.map((point) => ({ x: (point.x + shift.x) * scale, y: (point.y + shift.y) * scale }));

  const framePx = toPixels(frame);
  const cornerPx = toPixels(corner);
  const strokePx = STROKE * scale;
  const radiusPx = spec.radius * scale;

  const buffer = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let plateHits = 0;
      let markHits = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const point = { x: x + (sx + 0.5) * sub, y: y + (sy + 0.5) * sub };

          // Plate.
          if (spec.bleed || roundedRectDistance(point, size, radiusPx) <= 0) {
            plateHits += 1;
          }

          // The mark: the frame, stroked, plus the corner, filled.
          let distance = Number.POSITIVE_INFINITY;
          for (let i = 0; i < framePx.length; i += 1) {
            const a = framePx[i] as Point;
            const b = framePx[(i + 1) % framePx.length] as Point;
            distance = Math.min(distance, distanceToSegment(point, a, b));
          }
          if (distance <= strokePx / 2 || pointInPolygon(point, cornerPx)) {
            markHits += 1;
          }
        }
      }

      const total = samples * samples;
      const plateAlpha = plateHits / total;
      const markAlpha = markHits / total;
      const alpha = plateAlpha + markAlpha - plateAlpha * markAlpha;

      const offset = (y * size + x) * 4;
      if (alpha <= 0) {
        continue;
      }

      // White mark over the plate: straight-alpha composite, then un-premultiply.
      const white = 255;
      const red = (white * markAlpha + plate.r * plateAlpha * (1 - markAlpha)) / alpha;
      const green = (white * markAlpha + plate.g * plateAlpha * (1 - markAlpha)) / alpha;
      const blue = (white * markAlpha + plate.b * plateAlpha * (1 - markAlpha)) / alpha;

      buffer[offset] = Math.round(Math.min(255, red));
      buffer[offset + 1] = Math.round(Math.min(255, green));
      buffer[offset + 2] = Math.round(Math.min(255, blue));
      buffer[offset + 3] = Math.round(alpha * 255);
    }
  }

  return buffer;
}

/* ----------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline, then the pixels.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const target = y * (size * 4 + 1);
    raw[target] = 0;
    rgba.copy(raw, target + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The vector icon, from the same geometry as the rasters.
 *
 * Generated for the same reason the PNGs are: a hand-maintained `icon.svg` next
 * to four generated PNGs is two descriptions of one mark, and the day they
 * disagree nobody notices until a browser caches the wrong one.
 *
 * 8 units of padding on a 40-unit box is exactly the 80 % safe zone Android's
 * maskable icons require, which is why the mark does not fill its own viewBox.
 */
function renderSvg(seed: string): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40" role="img" aria-label="เหลี่ยมนอก">',
    '  <!-- GENERATED by `npm run brand:icons` from MARK in src/brand/brand.ts. -->',
    `  <rect width="40" height="40" rx="9" fill="${seed}" />`,
    `  <path d="${MARK.frame}" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" fill="none" />`,
    `  <path d="${MARK.corner}" fill="#ffffff" />`,
    '</svg>',
    '',
  ].join('\n');
}

/**
 * Wraps a PNG in the ICO container browsers ask for at `/favicon.ico`.
 *
 * Since Vista the format allows a PNG payload verbatim, so this is a 6-byte
 * header, one 16-byte directory entry, and the bytes already produced above —
 * considerably less code than a BMP encoder, and every browser in use reads it.
 */
function wrapIco(png: Buffer, size: number): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(1, 4); // one image in the file

  const entry = Buffer.alloc(16);
  // 0 means 256 in this format, which is the only way the byte can hold it.
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette entries: none, this is truecolour
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset: 6-byte header + 16-byte entry

  return Buffer.concat([header, entry, png]);
}

/* ------------------------------------------------------------------ preview */

/**
 * Reads a PNG this script wrote and returns its pixels.
 *
 * Only filter type 0 is emitted above, so decoding is "inflate and drop the
 * filter byte" — which is what makes `--preview` cheap enough to be worth having.
 * A regenerated icon is otherwise something you have to open an image viewer to
 * check, and that is exactly the step people skip.
 */
function decodePng(file: string): { size: number; rgba: Buffer } {
  const buffer = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const rgba = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride];
    if (filter !== 0) {
      throw new Error(`${file}: unexpected PNG filter ${filter}`);
    }
    raw.copy(rgba, y * width * 4, y * stride + 1, y * stride + 1 + width * 4);
  }

  return { size: width, rgba };
}

/** Renders pixels as text: `#` white, `+` mid, `o` plate, `.` dark, space clear. */
function ascii(rgba: Buffer, size: number, columns = 40): string {
  const rows: string[] = [];
  for (let row = 0; row < Math.round((columns * size) / size); row += 1) {
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

/* -------------------------------------------------------------------- driver */

function main(): void {
  const preview = process.argv.includes('--preview');
  const frame = parsePath(MARK.frame);
  const corner = parsePath(MARK.corner);
  const plate = hexToRgb(BRAND_SEED);

  if (frame.length < 3 || corner.length < 3) {
    console.error('Could not parse the mark geometry from src/brand/brand.ts.');
    process.exit(1);
  }

  console.log(`brand icons: rendering the mark from seed ${BRAND_SEED}`);

  writeFileSync('public/icon.svg', renderSvg(BRAND_SEED));
  console.log('  • public/icon.svg                   40×40  (vector, generated)');

  for (const spec of ICONS) {
    const pixels = renderIcon(spec, frame, corner, plate);
    const png = encodePng(spec.size, pixels);
    const output = spec.ico ? wrapIco(png, spec.size) : png;
    writeFileSync(spec.file, output);
    console.log(
      `  • ${spec.file.padEnd(34)} ${spec.size}×${spec.size}  ${(output.length / 1024).toFixed(1)} kB` +
        `${spec.bleed ? '  (full-bleed)' : ''}${spec.centre ? '  (centred for maskable)' : ''}` +
        `${spec.ico ? '  (ico container)' : ''}`,
    );
  }

  if (preview) {
    for (const spec of ICONS) {
      if (spec.ico) {
        continue;
      }
      const decoded = decodePng(spec.file);
      console.log(`\n${spec.file} (${decoded.size}×${decoded.size})`);
      console.log(ascii(decoded.rgba, decoded.size));
    }
  }

  console.log('  rerun after changing the mark: npm run brand:icons');
}

main();
