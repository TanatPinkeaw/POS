/**
 * What a customer can actually *do* with a receipt on the device they are holding.
 *
 * The shop's own phone answered this the hard way. `/shop/account` offered a
 * `ดาวน์โหลด` button, the customer tapped it, and nothing happened — no file, no error,
 * no sentence. The button was a Blob plus `<a download>`, which is exactly right in a
 * browser with a download manager and exactly nothing inside the browser LINE opens a
 * page in: a WKWebView with no download handling at all. A `a[download]` there is not a
 * failure the page can see; it is a no-op, which is worse, because there is nothing to
 * report and nothing to retry.
 *
 * So *how* a receipt leaves the screen is one decision with one answer, in preference
 * order:
 *
 *   1. **`share`** — the Web Share API with the PNG attached. On the phones this shop
 *      sells to, that is the "บันทึกไปยังรูปภาพ / Save to Files" sheet, and it is the one
 *      path that also works inside an embedded browser.
 *   2. **`download`** — a plain anchor download, for a desktop or a browser that has a
 *      download manager. Deliberately **not** offered inside LINE, Messenger or
 *      Instagram: there it is the silent no-op this module exists for.
 *   3. **`long-press`** — neither is available, so the receipt is drawn as an image with
 *      a sentence telling the customer to press and hold it. iOS turns that into the
 *      same save sheet, and it is the last resort that still works.
 *
 * Pure, and *given* its capabilities rather than reading the browser itself, so each of
 * those three answers is a test (`tests/receipt-save.test.ts`) rather than a claim about
 * somebody's phone. The capability probe lives with the screen that has a browser
 * (`AccountPortal`, `PublicReceipt`).
 */
export type ReceiptSaveAction = 'share' | 'download' | 'long-press';

export interface ReceiptSaveCapabilities {
  /**
   * `navigator.canShare({ files })` — not merely `navigator.share`. A share sheet that
   * takes text but not a file cannot hand over a receipt, and offering it would open a
   * sheet with nothing attached.
   */
  canShareFiles: boolean;
  /** `'download' in HTMLAnchorElement.prototype`. */
  canDownload: boolean;
  /** This page is running inside an app's own browser rather than a browser. */
  embeddedBrowser: boolean;
}

/** The one answer, from the three facts above. */
export function receiptSaveAction(caps: ReceiptSaveCapabilities): ReceiptSaveAction {
  if (caps.canShareFiles) {
    return 'share';
  }
  if (caps.canDownload && !caps.embeddedBrowser) {
    return 'download';
  }
  return 'long-press';
}

/**
 * Whether the page is inside an app's browser.
 *
 * The list is short on purpose, and each entry is there because that app's browser
 * ignores an anchor download rather than saving it: LINE (the shop reaches customers
 * there), and the three social browsers a customer might have opened a link from. A
 * false negative costs nothing worse than the old behaviour; a false positive only costs
 * a download button, because `canShareFiles` is checked first either way.
 *
 * `; wv)` is the WebView marker Android puts in the user agent (Chrome custom tabs and
 * `WebView`), which is how a page tells "an app is showing me" from "a browser is".
 */
export function isEmbeddedBrowser(userAgent: string): boolean {
  return /Line\/|FBAN|FBAV|Instagram|; wv\)/i.test(userAgent);
}

/**
 * The same three facts, read off the browser that is running.
 *
 * The impure half, kept beside the decision so that the two screens that offer a receipt
 * (`/shop/account` and `/receipts`) cannot probe the browser differently — one of them
 * asking `navigator.share` without `canShare`, the other not asking at all, is how two
 * screens end up disagreeing about what the same phone can do. Only callable in a
 * browser: it touches `navigator`, `document` and `File`.
 *
 * `canShare` is asked with a real empty `File`, not with `{ files: [] }` — an empty list
 * is not the question. A share sheet that takes text but not a picture cannot hand over a
 * receipt, and offering it would open a sheet with nothing attached to it.
 */
export function browserReceiptCapabilities(): ReceiptSaveCapabilities {
  const share = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  const probe =
    typeof File === 'undefined' ? null : new File([new Blob()], 'receipt.png', { type: 'image/png' });
  return {
    canShareFiles:
      share.canShare !== undefined && probe !== null && share.canShare({ files: [probe] }),
    canDownload: 'download' in document.createElement('a'),
    embeddedBrowser: isEmbeddedBrowser(navigator.userAgent),
  };
}
