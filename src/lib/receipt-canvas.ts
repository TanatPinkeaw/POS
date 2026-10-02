/**
 * Drawing a receipt onto a canvas — the "printer-less slip" of CONTEXT item 13.
 *
 * **Deliberately free of imports.** This module is the one the browser journey
 * compiles and runs in real Chromium to prove the drawing works (the way
 * `offline-db.ts` is probed), and a runtime import would break that: the probe
 * transpiles this file alone and evaluates it, so everything it needs must come in
 * as an argument. The document's *content* — which rows, in what words — is built
 * by `receipt-image.ts`, which may import the shared vocabulary; this file only
 * knows how to put a line on a canvas.
 *
 * The line shape mirrors `Receipt.tsx`'s markup rather than a PDF's model: the
 * order of the rows, the alignment of a label against its value, and the three
 * weights the receipt actually uses.
 */
export interface ReceiptCanvasLine {
  readonly kind: 'shop' | 'small' | 'title' | 'call' | 'row' | 'smallRow' | 'grandRow' | 'totalRow' | 'rule' | 'foot';
  /** Left text for a text line, or the label of a row. */
  readonly text?: string;
  readonly label?: string;
  /** The right-aligned value of a row. */
  readonly value?: string;
}

export interface ReceiptCanvasOptions {
  /** Width in pixels — a 58mm roll at 8 dots/mm is roughly 384. */
  readonly width: number;
  readonly padding: number;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly ruleHeight: number;
  readonly fontFamily: string;
}

/** A 58mm roll: 384px wide at 8 dots/mm, which is the paper a till prints. */
export const DEFAULT_RECEIPT_CANVAS: ReceiptCanvasOptions = {
  width: 384,
  padding: 16,
  fontSize: 15,
  lineHeight: 22,
  ruleHeight: 12,
  fontFamily: '"Noto Sans Thai", "Inter", sans-serif',
};

/**
 * How tall the document will be, so a caller can size the canvas before drawing.
 *
 * Separated from `drawReceipt` because a canvas's height is fixed at creation: the
 * caller must know the height *before* it has anything to draw, or it draws onto a
 * default 150px canvas and clips the bill.
 */
export function receiptCanvasHeight(
  lines: readonly ReceiptCanvasLine[],
  options: ReceiptCanvasOptions = DEFAULT_RECEIPT_CANVAS,
): number {
  let height = options.padding * 2;
  for (const line of lines) {
    if (line.kind === 'rule') {
      height += options.ruleHeight;
    } else if (line.kind === 'call') {
      height += options.lineHeight * 1.8;
    } else {
      height += options.lineHeight;
    }
  }
  return Math.ceil(height);
}

/**
 * Draws the document top-down and returns the height it occupied.
 *
 * Every weight change is a `ctx.font` assignment rather than a separate font
 * file: the images are small, and asking the browser to load three families for
 * one slip would race the first draw.
 */
export function drawReceipt(
  ctx: CanvasRenderingContext2D,
  lines: readonly ReceiptCanvasLine[],
  options: ReceiptCanvasOptions = DEFAULT_RECEIPT_CANVAS,
): number {
  const right = options.width - options.padding;
  const bold = (size: number): string => `600 ${size}px ${options.fontFamily}`;
  const regular = (size: number): string => `${size}px ${options.fontFamily}`;

  ctx.textBaseline = 'top';
  let y = options.padding;

  for (const line of lines) {
    switch (line.kind) {
      case 'rule': {
        y += options.ruleHeight / 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(options.padding, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        y += options.ruleHeight / 2;
        break;
      }
      case 'call': {
        const size = Math.round(options.fontSize * 1.6);
        ctx.font = regular(size);
        ctx.textAlign = 'left';
        ctx.fillText(line.label ?? '', options.padding, y + size * 0.1);
        ctx.font = bold(size);
        ctx.textAlign = 'right';
        ctx.fillText(line.value ?? '', right, y);
        ctx.textAlign = 'left';
        y += options.lineHeight * 1.8;
        break;
      }
      case 'shop': {
        ctx.font = bold(options.fontSize + 3);
        ctx.textAlign = 'left';
        ctx.fillText(line.text ?? '', options.padding, y);
        y += options.lineHeight;
        break;
      }
      case 'title': {
        ctx.font = bold(options.fontSize);
        ctx.textAlign = 'center';
        ctx.fillText(line.text ?? '', options.width / 2, y);
        ctx.textAlign = 'left';
        y += options.lineHeight;
        break;
      }
      case 'small':
      case 'foot': {
        ctx.font = regular(options.fontSize - 2);
        ctx.textAlign = line.kind === 'foot' ? 'center' : 'left';
        ctx.fillText(line.text ?? '', line.kind === 'foot' ? options.width / 2 : options.padding, y);
        ctx.textAlign = 'left';
        y += options.lineHeight;
        break;
      }
      default: {
        // A row: a label on the left, a figure against the right margin.
        const weight = line.kind === 'grandRow' || line.kind === 'totalRow';
        const size = line.kind === 'smallRow' ? options.fontSize - 2 : options.fontSize;
        ctx.font = weight ? bold(size) : regular(size);
        ctx.textAlign = 'left';
        ctx.fillText(line.label ?? '', options.padding, y);
        ctx.textAlign = 'right';
        ctx.fillText(line.value ?? '', right, y);
        ctx.textAlign = 'left';
        y += options.lineHeight;
        break;
      }
    }
  }

  return y + options.padding;
}
