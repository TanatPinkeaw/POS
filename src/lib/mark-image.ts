/**
 * Reading the brand artwork, and rendering it into an app icon.
 *
 * Pure, and separate from `scripts/build-icons.ts` for the reason `palette.ts` is
 * separate from `scripts/brand-palette.ts`: an entry point that only runs from
 * `main()` cannot be tested without writing files, and this is arithmetic a wrong
 * answer hides in — a mis-decoded scanline or a resize that keeps the wrong phase
 * produces a picture that looks *plausible*, which is the worst kind of wrong for
 * something whose whole job is to look like the shop's logo. `tests/mark-image.test.ts`
 * decodes the committed file and renders every icon size from it.
 *
 * Two things the icons rest on, stated here because they are not visible from the
 * call sites:
 *
 *   * **The artwork is read, not assumed.** It was not written by this repository, so
 *     all five PNG scanline filters and both truecolour formats have to be handled.
 *     Only filter 0 is ever *written* — `encodePng`'s `filter` parameter exists so the
 *     reader's other four branches can be exercised with a file that goes through the
 *     same encoder, because the artwork itself happens to use Paeth on every row and
 *     therefore only ever tests one of them.
 *   * **Reduction is an area average in premultiplied alpha.** Every icon is a
 *     downscale — 500 px of artwork into 48–512 px of icon — which is exactly where
 *     point sampling is visibly wrong: it keeps or loses the letter's diagonal
 *     depending on the phase of the resize. Averaging premultiplied is what stops the
 *     transparent background dragging dark edges into the mark.
 */
import { deflateSync, inflateSync } from 'node:zlib';

import type { Rgb } from './color';

export interface Decoded {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA, 8 bits per channel. */
  rgba: Buffer;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What to draw, minus where to put it. */
export interface IconRasterSpec {
  /** Edge length in pixels. */
  size: number;
  /** Plate corner radius, as a fraction of the edge (9 of 40, in mark units). */
  radius: number;
  /** Full-bleed square plate: iOS and Android's maskable icons both mask it. */
  bleed: boolean;
}

/**
 * How much of an icon's edge the mark's own bounding box takes up.
 *
 * 60 % is carried over from the vector icons this replaced rather than re-chosen: it
 * is what leaves the mark inside Android's 66 % safe zone once a maskable icon has
 * been cropped to a circle, and what keeps an installed icon the same shape as the
 * one in the sidebar. Android's own logo files use the same figure.
 */
export const MARK_CONTENT = 0.6;

/**
 * Alpha at or above which a pixel counts as artwork, when the bounding box is
 * measured.
 *
 * Measured rather than assumed: the supplied file's alpha is a threshold cut, and a
 * few hundred pixels around its edge carry a partial fringe. Counting those would
 * stretch the box a pixel or two outward, which shrinks the mark in every icon for no
 * reason.
 */
export const ARTWORK_ALPHA_FLOOR = 8;

/* ---------------------------------------------------------------- decoding */

/** PNG's Paeth predictor: whichever neighbour the gradient between them lands on. */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) {
    return left;
  }
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * Reverses PNG's per-scanline filters — all five of them.
 *
 * Each row predicts from the row above it *after* that row has been decoded, which is
 * why this is a walk and not a per-row copy from the inflated stream.
 */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let offset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[offset] as number;
    offset += 1;
    const row = y * stride;
    const above = row - stride;

    for (let i = 0; i < stride; i += 1) {
      const value = raw[offset + i] as number;
      const left = i >= channels ? (out[row + i - channels] as number) : 0;
      const up = y > 0 ? (out[above + i] as number) : 0;
      const upLeft = y > 0 && i >= channels ? (out[above + i - channels] as number) : 0;

      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`PNG scanline ${y}: unknown filter ${filter}`);
      }
      out[row + i] = restored & 0xff;
    }

    offset += stride;
  }

  return out;
}

/**
 * Reads a PNG into straight RGBA.
 *
 * Only the two truecolour formats an illustration is exported as, at 8 bits per
 * channel: an indexed or 16-bit file is a conversation about the artwork, not a case
 * this should guess at, so it fails loudly by name instead of producing a
 * plausible-looking icon.
 */
export function decodePng(file: Buffer): Decoded {
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colour = 0;
  const idat: Buffer[] = [];

  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8] as number;
      colour = data[9] as number;
    }
    if (type === 'IDAT') {
      idat.push(data);
    }
    // This chunk's data, plus its 4-byte length, 4-byte type and 4-byte CRC.
    offset += 12 + length;
  }

  if (depth !== 8 || (colour !== 6 && colour !== 2)) {
    throw new Error(
      `mark: expected 8-bit truecolour, found colour type ${colour} at depth ${depth}. ` +
        'Export the artwork as a plain 8-bit RGB or RGBA PNG.',
    );
  }

  const channels = colour === 6 ? 4 : 3;
  const planes = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);
  if (channels === 4) {
    return { width, height, rgba: planes };
  }

  // Everything below this line wants RGBA, so an opaque source is widened once here
  // rather than branched on inside the sampling loop.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = planes[i * 3] as number;
    rgba[i * 4 + 1] = planes[i * 3 + 1] as number;
    rgba[i * 4 + 2] = planes[i * 3 + 2] as number;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/* ----------------------------------------------------------------- geometry */

/**
 * The artwork's own bounding box, from its alpha.
 *
 * Measured rather than taken to be the canvas. The drawing sits inside about two
 * thirds of the file, so scaling the *canvas* would put the mark in an icon at
 * whatever fraction the last export happened to use — and a re-export with different
 * margins would silently resize every icon in the app.
 */
export function contentBox(art: Decoded): Box {
  let minX = art.width;
  let minY = art.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < art.height; y += 1) {
    for (let x = 0; x < art.width; x += 1) {
      if ((art.rgba[(y * art.width + x) * 4 + 3] as number) < ARTWORK_ALPHA_FLOOR) {
        continue;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    throw new Error('mark: every pixel is transparent — is this the artwork?');
  }

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Signed distance to a rounded rectangle centred in a `size` box. */
function roundedRectDistance(x: number, y: number, size: number, radius: number): number {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/* ---------------------------------------------------------------- rasteriser */

/**
 * Draws one icon: a plate, the artwork centred on it, and nothing else.
 *
 * The divisor is the destination pixel's whole footprint, not the weight that
 * happened to be covered, so a partly transparent source pixel stays partly
 * transparent instead of being normalised up to opaque. The plate is analytic and so
 * is 4×4 supersampled; the two are composited in straight alpha at the end.
 */
export function renderIcon(spec: IconRasterSpec, art: Decoded, plate: Rgb): Buffer {
  const { size } = spec;
  const box = contentBox(art);
  const scale = (MARK_CONTENT * size) / Math.max(box.width, box.height);
  const markWidth = box.width * scale;
  const markHeight = box.height * scale;
  const originX = (size - markWidth) / 2;
  const originY = (size - markHeight) / 2;
  const radiusPx = spec.radius * size;
  const samples = 4;
  const total = samples * samples;
  const sub = 1 / samples;

  const buffer = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // The plate, supersampled so its corner is a curve and not a staircase.
      let plateAlpha = 1;
      if (!spec.bleed) {
        let hits = 0;
        for (let sy = 0; sy < samples; sy += 1) {
          for (let sx = 0; sx < samples; sx += 1) {
            const probe = roundedRectDistance(
              x + (sx + 0.5) * sub,
              y + (sy + 0.5) * sub,
              size,
              radiusPx,
            );
            if (probe <= 0) {
              hits += 1;
            }
          }
        }
        plateAlpha = hits / total;
      }

      // The artwork, averaged over this pixel's footprint in source space.
      const left = (x - originX) / scale + box.x;
      const right = (x + 1 - originX) / scale + box.x;
      const top = (y - originY) / scale + box.y;
      const bottom = (y + 1 - originY) / scale + box.y;
      const cover = (right - left) * (bottom - top);

      let alphaSum = 0;
      let redSum = 0;
      let greenSum = 0;
      let blueSum = 0;

      const firstX = Math.max(0, Math.floor(left));
      const lastX = Math.min(art.width, Math.ceil(right));
      const firstY = Math.max(0, Math.floor(top));
      const lastY = Math.min(art.height, Math.ceil(bottom));

      for (let sourceY = firstY; sourceY < lastY; sourceY += 1) {
        const overlapY = Math.min(sourceY + 1, bottom) - Math.max(sourceY, top);
        if (overlapY <= 0) {
          continue;
        }
        for (let sourceX = firstX; sourceX < lastX; sourceX += 1) {
          const overlapX = Math.min(sourceX + 1, right) - Math.max(sourceX, left);
          if (overlapX <= 0) {
            continue;
          }
          const weight = overlapX * overlapY;
          const at = (sourceY * art.width + sourceX) * 4;
          const alpha = (art.rgba[at + 3] as number) / 255;
          alphaSum += weight * alpha;
          redSum += weight * alpha * (art.rgba[at] as number);
          greenSum += weight * alpha * (art.rgba[at + 1] as number);
          blueSum += weight * alpha * (art.rgba[at + 2] as number);
        }
      }

      const artAlpha = alphaSum / cover;
      const alpha = artAlpha + plateAlpha * (1 - artAlpha);
      if (alpha <= 0) {
        continue;
      }

      // Premultiplied artwork over the plate, then back to straight alpha.
      const offset = (y * size + x) * 4;
      buffer[offset] = Math.round(
        Math.min(255, (redSum / cover + plate.r * plateAlpha * (1 - artAlpha)) / alpha),
      );
      buffer[offset + 1] = Math.round(
        Math.min(255, (greenSum / cover + plate.g * plateAlpha * (1 - artAlpha)) / alpha),
      );
      buffer[offset + 2] = Math.round(
        Math.min(255, (blueSum / cover + plate.b * plateAlpha * (1 - artAlpha)) / alpha),
      );
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

/**
 * Writes a square RGBA PNG.
 *
 * One filter byte (0 = None) per scanline, which is the whole format for an image
 * with no palette and no interlacing. The reader understands the other four filters
 * because it has to read files this writer did not produce; nothing here needs to
 * write them.
 */
export function encodePng(size: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    const target = y * (stride + 1);
    raw[target] = 0;
    rgba.copy(raw, target + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Wraps a PNG in the ICO container browsers ask for at `/favicon.ico`.
 *
 * Since Vista the format allows a PNG payload verbatim, so this is a 6-byte header,
 * one 16-byte directory entry, and the bytes already produced above — considerably
 * less code than a BMP encoder, and every browser in use reads it.
 */
export function wrapIco(png: Buffer, size: number): Buffer {
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
