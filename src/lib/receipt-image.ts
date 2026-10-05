/**
 * The receipt as a picture (ADR 0021).
 *
 * `Receipt.tsx` renders the slip as DOM for the screen and the 80mm print; this
 * module renders the same document as an image a customer can keep, generated on
 * demand from the order's own figures rather than read back from a stored file.
 *
 * **This is a second renderer, and it is kept in step with `Receipt.tsx` by hand.**
 * That cost is deliberate (ADR 0021 §4): the alternative — storing the rendered
 * file — buys a storage layer and a second source of truth that can silently
 * disagree with the order it claims to show. The rows here are written in the same
 * order, with the same Thai labels and the same snapshotted figures, as the DOM
 * receipt; if one changes, so must the other.
 *
 * The drawing itself lives in `receipt-canvas.ts`, which imports nothing so the
 * browser journey can compile and run it in real Chromium. This module is where the
 * document's *content* is decided, and it may use the shared vocabulary
 * (`vatLabel`, `tenderLabel`) because it is only ever imported by the app and the
 * unit tests.
 */
import type { ReceiptData } from '@/components/pos/Receipt';

import { bangkokDayString, bangkokTimeString } from './bangkok-time';
import {
  DEFAULT_RECEIPT_CANVAS,
  drawReceipt,
  receiptCanvasHeight,
  type ReceiptCanvasLine,
  type ReceiptCanvasOptions,
} from './receipt-canvas';
import { vatLabel, type ShopView } from './shop-view';
import { tenderedAmount, tenderLabel } from './tender';

/** `107` → `107.00`, the same two decimals the DOM receipt prints. */
const baht = (amount: number): string => amount.toFixed(2);

/**
 * The document, top to bottom, as lines the canvas can draw.
 *
 * Mirrors `Receipt.tsx` row for row. `when` overrides `data.createdAt` for a
 * reprint, exactly as the component's `when` prop does.
 */
export function buildReceiptLines(
  shop: ShopView,
  data: ReceiptData,
  when?: string,
): ReceiptCanvasLine[] {
  const timestamp = when ?? data.createdAt;
  const moment = timestamp ? new Date(timestamp) : new Date();

  const lines: ReceiptCanvasLine[] = [{ kind: 'shop', text: shop.name }];

  if (shop.branchLabel) lines.push({ kind: 'small', text: shop.branchLabel });
  if (shop.address) lines.push({ kind: 'small', text: shop.address });
  if (shop.phone) lines.push({ kind: 'small', text: `โทร. ${shop.phone}` });
  if (data.isVatInvoice && shop.taxId) {
    lines.push({ kind: 'small', text: `เลขประจำตัวผู้เสียภาษี ${shop.taxId}` });
  }

  lines.push({
    kind: 'title',
    text: data.isVatInvoice ? 'ใบกำกับภาษีอย่างย่อ / ใบเสร็จรับเงิน' : 'ใบเสร็จรับเงิน',
  });

  // The call number sits above the document's own number, as on the DOM receipt:
  // it is the figure a customer reads while their order is being made.
  if (data.queueNumber) lines.push({ kind: 'call', label: 'คิวที่', value: data.queueNumber });

  lines.push({ kind: 'row', label: 'เลขที่', value: data.receiptNumber ?? data.orderNumber });
  if (data.receiptNumber) {
    lines.push({ kind: 'row', label: 'ออเดอร์', value: data.orderNumber });
  }
  lines.push({
    kind: 'row',
    label: 'วันที่',
    value: `${bangkokDayString(moment)} ${bangkokTimeString(moment)}`,
  });

  lines.push({ kind: 'rule' });
  for (const line of data.lines) {
    lines.push({ kind: 'row', label: `${line.name} × ${line.quantity}`, value: baht(line.totalPrice) });
  }
  lines.push({ kind: 'rule' });

  lines.push({ kind: 'row', label: 'รวม', value: baht(data.subtotalThb) });
  if (data.discountThb > 0) {
    lines.push({ kind: 'row', label: 'ส่วนลด', value: `-${baht(data.discountThb)}` });
  }

  // Only a VAT sale prints the tax split, and it is the *stored* split, so the
  // lines always add back up to the total.
  if (data.isVatInvoice) {
    lines.push({ kind: 'smallRow', label: 'ยอดก่อน VAT', value: baht(data.netThb) });
    lines.push({ kind: 'smallRow', label: vatLabel(data.vatRatePercent ?? 0), value: baht(data.vatThb) });
  }

  lines.push({ kind: 'grandRow', label: 'ยอดชำระ', value: baht(data.finalAmountThb) });

  // One line per money leg, so a ฿35 bill paid with a ฿100 note reads 100.00
  // beside a 65.00 change — a single "รับเงิน 35.00" would not add up.
  for (const tender of data.tenders) {
    lines.push({ kind: 'row', label: tenderLabel(tender.method), value: baht(tenderedAmount(tender)) });
  }
  lines.push({ kind: 'totalRow', label: 'เงินทอน', value: baht(data.changeThb) });

  if (data.pointsRedeemed > 0) {
    lines.push({ kind: 'smallRow', label: 'ใช้คะแนน', value: String(data.pointsRedeemed) });
  }
  if (data.pointsEarned > 0) {
    lines.push({ kind: 'foot', text: `ได้รับ ${data.pointsEarned} คะแนน` });
  }

  lines.push({ kind: 'foot', text: shop.receiptFooter?.trim() || 'ขอบคุณที่ใช้บริการ' });

  return lines;
}

/**
 * Draws the receipt onto a canvas sized to the document.
 *
 * The canvas must be created at the right height *before* drawing (a canvas cannot
 * grow), which is why `receiptCanvasHeight` exists rather than being folded in.
 */
export function drawReceiptToCanvas(
  shop: ShopView,
  data: ReceiptData,
  options: ReceiptCanvasOptions = DEFAULT_RECEIPT_CANVAS,
  when?: string,
): HTMLCanvasElement {
  const lines = buildReceiptLines(shop, data, when);
  const canvas = document.createElement('canvas');
  canvas.width = options.width;
  canvas.height = receiptCanvasHeight(lines, options);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D is not available in this browser');
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  drawReceipt(ctx, lines, options);

  return canvas;
}

/**
 * The canvas receipt in the shop's own Thai font.
 *
 * `receipt-canvas.ts` is deliberately import-free — the browser journey
 * transpiles that file alone — so it cannot read the `next/font` variable
 * itself; everything it needs arrives as an argument. This module may use the
 * shared vocabulary, so the family is resolved here from the computed
 * `--font-thai`, which is whatever the root layout self-hosted at build time
 * (Mitr today). Read at call time rather than module load, and fall back to the
 * default where there is no document to read from (unit tests, server
 * rendering): a PNG drawn off-document is a test artefact, never a slip a
 * customer keeps.
 */
export function systemThaiFont(): string {
  if (typeof document === 'undefined') {
    return DEFAULT_RECEIPT_CANVAS.fontFamily;
  }
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-thai')
    .trim();
  return resolved.length > 0 ? resolved : DEFAULT_RECEIPT_CANVAS.fontFamily;
}

/** The same document as a PNG data URL, for a download link or an `<img>`. */
export function receiptImageDataUrl(
  shop: ShopView,
  data: ReceiptData,
  when?: string,
): string {
  return drawReceiptToCanvas(
    shop,
    data,
    { ...DEFAULT_RECEIPT_CANVAS, fontFamily: systemThaiFont() },
    when,
  ).toDataURL('image/png');
}
