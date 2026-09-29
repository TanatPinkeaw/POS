/**
 * The icon pipeline's arithmetic, and the committed artwork it runs on.
 *
 * Two things are being protected here, and only one of them is the code. The other is
 * `public/brand-mark.png`: since ADR 0015 the mark *is* that file, it is the only copy
 * of the platform's identity, and it is a binary nobody can review by reading. This
 * suite is the only thing that reads it short of a person opening it, so it checks the
 * properties every icon depends on rather than the numbers `npm run brand:icons`
 * prints, which move whenever the shop re-exports.
 *
 * The PNG fixtures are built here rather than by `encodePng`, because the reader has to
 * cope with files that came from somewhere else and a round trip through the writer
 * would let a shared mistake hide.
 */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { MARK } from '@/brand/brand';
import { contentBox, decodePng, encodePng, MARK_CONTENT, renderIcon, wrapIco } from '@/lib/mark-image';

/* --------------------------------------------------------------- png fixtures */

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
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

/** PNG's Paeth predictor, forward: what the reader has to undo. */
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
 * A square truecolour PNG with one filter applied to every scanline.
 *
 * `channels` of 3 writes colour type 2 — no alpha channel at all, which is what a
 * design tool exports when a logo has no transparency to keep.
 */
function makePng(size: number, rgba: Buffer, filter: number, channels = 4): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * channels;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    const target = y * (stride + 1);
    raw[target] = filter;
    for (let i = 0; i < stride; i += 1) {
      const value = rgba[y * stride + i] as number;
      const left = i >= channels ? (rgba[y * stride + i - channels] as number) : 0;
      const up = y > 0 ? (rgba[(y - 1) * stride + i] as number) : 0;
      const upLeft =
        y > 0 && i >= channels ? (rgba[(y - 1) * stride + i - channels] as number) : 0;

      let predicted: number;
      switch (filter) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4:
          predicted = paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`no fixture writer for PNG filter ${filter}`);
      }
      raw[target + 1 + i] = (value - predicted) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A square image from one colour, RGBA. */
function solid(size: number, colour: [number, number, number, number]): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba.set(colour, i * 4);
  }
  return rgba;
}

/** A square whose pixels all differ, so a filter has something to predict. */
function gradient(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = (i * 7) % 256;
    rgba[i * 4 + 1] = (i * 13) % 256;
    rgba[i * 4 + 2] = (i * 29) % 256;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

const pixel = (rgba: Buffer, size: number, x: number, y: number): number[] => {
  const at = (y * size + x) * 4;
  return [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]] as number[];
};

const PLATE = { r: 251, g: 218, b: 178 };

describe('decodePng', () => {
  // The artwork this repository reads was written by somebody else's encoder, and it
  // happens to use Paeth on every row — so without these, four of the reader's five
  // branches would never run against anything.
  it.each([0, 1, 2, 3, 4])('reads back a file written with filter %i', (filter) => {
    const source = gradient(8);
    expect(decodePng(makePng(8, source, filter)).rgba).toEqual(source);
  });

  it('reads back what this repository writes', () => {
    const source = gradient(8);
    expect(decodePng(encodePng(8, source)).rgba).toEqual(source);
  });

  it('gives an image with no alpha channel one, instead of refusing it', () => {
    // Colour type 2: three bytes per pixel, so the fixture has to be built with three.
    const rgb = Buffer.alloc(2 * 2 * 3);
    rgb.set([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);

    const decoded = decodePng(makePng(2, rgb, 0, 3));

    expect([decoded.width, decoded.height]).toEqual([2, 2]);
    expect(pixel(decoded.rgba, 2, 1, 1)).toEqual([100, 110, 120, 255]);
  });

  it('refuses a format it cannot read, by name', () => {
    // Colour type 3 (indexed), at byte 9 of the IHDR payload.
    const indexed = makePng(2, solid(2, [1, 2, 3, 255]), 0);
    indexed[25] = 3;

    expect(() => decodePng(indexed)).toThrow(/colour type 3/);
  });
});

describe('contentBox', () => {
  it('measures the drawing rather than the canvas', () => {
    // 6×6, with a 2×3 block of ink at (1,2).
    const art = decodePng(encodePng(6, solid(6, [0, 0, 0, 0])));
    for (let y = 2; y < 5; y += 1) {
      for (let x = 1; x < 3; x += 1) {
        art.rgba[(y * 6 + x) * 4 + 3] = 255;
      }
    }

    expect(contentBox(art)).toEqual({ x: 1, y: 2, width: 2, height: 3 });
  });

  it('walks past the fringe a thresholded export leaves behind', () => {
    const art = decodePng(encodePng(4, solid(4, [0, 0, 0, 0])));
    art.rgba[(1 * 4 + 1) * 4 + 3] = 255;
    art.rgba[(0 * 4 + 0) * 4 + 3] = 7; // below the floor: not a pixel of the mark
    expect(contentBox(art)).toEqual({ x: 1, y: 1, width: 1, height: 1 });

    art.rgba[(0 * 4 + 0) * 4 + 3] = 8; // the floor itself counts
    expect(contentBox(art)).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  it('refuses an image with no artwork in it', () => {
    expect(() => contentBox(decodePng(encodePng(4, solid(4, [0, 0, 0, 0]))))).toThrow(
      /every pixel is transparent/,
    );
  });
});

describe('renderIcon', () => {
  const spec = { size: 100, radius: 0.225, bleed: false };
  const art = decodePng(encodePng(20, solid(20, [220, 40, 30, 255])));

  it('draws the mark at the share of the edge it promises, centred', () => {
    const icon = renderIcon(spec, art, PLATE);
    const edge = Math.round(MARK_CONTENT * spec.size); // 60 of 100
    const first = (spec.size - edge) / 2; // 20
    const last = first + edge; // 80

    expect(pixel(icon, spec.size, spec.size / 2, spec.size / 2)).toEqual([220, 40, 30, 255]);
    expect(pixel(icon, spec.size, first, spec.size / 2)).toEqual([220, 40, 30, 255]);
    expect(pixel(icon, spec.size, last - 1, spec.size / 2)).toEqual([220, 40, 30, 255]);
    expect(pixel(icon, spec.size, first - 1, spec.size / 2)).toEqual([251, 218, 178, 255]);
    expect(pixel(icon, spec.size, last, spec.size / 2)).toEqual([251, 218, 178, 255]);
  });

  it('rounds the plate off, and bleeds it when the platform is the one masking', () => {
    expect(pixel(renderIcon(spec, art, PLATE), spec.size, 0, 0)[3]).toBe(0);
    expect(pixel(renderIcon(spec, art, PLATE), spec.size, 0, spec.size / 2)[3]).toBe(255);

    const bled = renderIcon({ ...spec, radius: 0, bleed: true }, art, PLATE);
    expect(pixel(bled, spec.size, 0, 0)).toEqual([251, 218, 178, 255]);
  });

  it('averages a partly transparent pixel against the plate instead of darkening it', () => {
    /*
     * One white pixel at half alpha, scaled up. The plate is opaque, so what a partial
     * pixel shows as is a *colour*: half white and half plate, by alpha. Averaging
     * without premultiplying, or dividing by the weight that happened to be covered
     * rather than by the footprint, moves this number.
     */
    const half = decodePng(encodePng(1, solid(1, [255, 255, 255, 128])));
    const icon = renderIcon({ size: 20, radius: 0, bleed: true }, half, PLATE);

    // 255·0.502 + 251·0.498, and the same for the other two channels.
    expect(pixel(icon, 20, 10, 10)).toEqual([253, 237, 217, 255]);
  });

  it('gives a transparent background nothing to contribute', () => {
    /*
     * A white square on a ground that is fully transparent *and fully black* — which is
     * what a cut-out export actually looks like. Those dark pixels sit inside the
     * footprint of the pixels at the mark's edge, so an average taken without
     * premultiplying drags the plate toward black exactly there.
     */
    const art = decodePng(encodePng(40, solid(40, [0, 0, 0, 0])));
    for (let y = 16; y < 24; y += 1) {
      for (let x = 16; x < 24; x += 1) {
        const at = (y * 40 + x) * 4;
        art.rgba[at] = 255;
        art.rgba[at + 1] = 255;
        art.rgba[at + 2] = 255;
        art.rgba[at + 3] = 255;
      }
    }
    const icon = renderIcon({ size: 20, radius: 0, bleed: true }, art, PLATE);

    expect(pixel(icon, 20, 5, 10)).toEqual([255, 255, 255, 255]); // inside the square
    expect(pixel(icon, 20, 3, 10)).toEqual([251, 218, 178, 255]); // over the black fringe
  });
});

describe('wrapIco', () => {
  const png = encodePng(2, solid(2, [9, 9, 9, 255]));

  it('describes the image it carries', () => {
    const ico = wrapIco(png, 48);

    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // an icon, not a cursor
    expect(ico.readUInt16LE(4)).toBe(1); // one image in the file
    expect(ico[6]).toBe(48);
    expect(ico[7]).toBe(48);
    expect(ico.readUInt16LE(12)).toBe(32); // bits per pixel
    expect(ico.readUInt32LE(14)).toBe(png.length);
    expect(ico.readUInt32LE(18)).toBe(22); // where the payload starts
    expect(ico.length).toBe(22 + png.length);
  });

  it('writes 256 as the zero the format needs', () => {
    expect(wrapIco(png, 512)[6]).toBe(0);
  });
});

describe('the artwork the icons are made from', () => {
  /*
   * Every one of these is a property the icon pipeline depends on, not a number the
   * current file happens to have: a re-export at a different size, or with a different
   * margin, passes all of them, and a truncated or wrongly saved file fails the first.
   */
  const art = decodePng(readFileSync(MARK.file));

  it('decodes, at a size worth resampling', () => {
    expect(Math.min(art.width, art.height)).toBeGreaterThanOrEqual(64);
    expect(art.rgba.length).toBe(art.width * art.height * 4);
  });

  it('is a mark on a transparent ground, not an opaque picture', () => {
    let clear = 0;
    let opaque = 0;
    for (let i = 0; i < art.width * art.height; i += 1) {
      const alpha = art.rgba[i * 4 + 3] as number;
      if (alpha === 0) clear += 1;
      if (alpha === 255) opaque += 1;
    }

    // Both halves matter: with no transparency the mark is a rectangle sitting on the
    // shell, and with no ink there is no mark to put on the plate.
    expect(clear).toBeGreaterThan(0);
    expect(opaque).toBeGreaterThan(0);
  });

  it('has the drawing filling a usable part of the canvas', () => {
    const box = contentBox(art);

    // A floor, not the measurement: `renderIcon` scales by this box, so a small one is
    // not a rendering bug — but it means every icon is being blown up from very few
    // pixels, which is worth failing on before somebody installs it.
    expect(box.width).toBeGreaterThan(art.width * 0.25);
    expect(box.height).toBeGreaterThan(art.height * 0.25);
    expect(box.x + box.width).toBeLessThanOrEqual(art.width);
    expect(box.y + box.height).toBeLessThanOrEqual(art.height);
  });

  it('renders into an icon with the mark actually in it', () => {
    const size = 192;
    const icon = renderIcon({ size, radius: 0.225, bleed: false }, art, PLATE);

    expect(pixel(icon, size, size / 2, size / 2)[3]).toBe(255);
    expect(pixel(icon, size, 0, 0)[3]).toBe(0);

    // The icon is neither all plate nor all ink: a plate with nothing on it would pass
    // the two assertions above, and so would artwork that filled its own square.
    const colours = new Set<string>();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const [r, g, b, alpha] = pixel(icon, size, x, y) as [number, number, number, number];
        if (alpha === 255) {
          colours.add(`${r},${g},${b}`);
        }
      }
    }
    expect(colours.size).toBeGreaterThan(1);
  });
});
