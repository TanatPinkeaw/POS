/**
 * The receipt-on-a-phone decision — `src/lib/receipt-save.ts`.
 *
 * The failure this pins down was reported from the shop's own phone: the customer
 * pressed `ดาวน์โหลด` in `/shop/account`, and nothing happened — no file, no error. The
 * button was a Blob and an `<a download>`, which is a no-op inside LINE's in-app
 * browser (a WKWebView with no download handling), so the one screen that could have
 * said something said nothing.
 *
 * Every case below is a device the shop actually meets, and the assertion is which of
 * the three mechanisms is chosen — not that some code ran.
 */
import { describe, expect, it } from 'vitest';

import {
  isEmbeddedBrowser,
  receiptSaveAction,
  type ReceiptSaveCapabilities,
} from '@/lib/receipt-save';

const caps = (over: Partial<ReceiptSaveCapabilities> = {}): ReceiptSaveCapabilities => ({
  canShareFiles: false,
  canDownload: true,
  embeddedBrowser: false,
  ...over,
});

describe('how a receipt leaves the screen', () => {
  it('shares the file whenever the share sheet can take one', () => {
    // The phone this shop sells to: the share sheet's "บันทึกไปยังรูปภาพ" is the only
    // path a customer recognises, and it is the only one that works inside LINE.
    expect(receiptSaveAction(caps({ canShareFiles: true }))).toBe('share');
    expect(receiptSaveAction(caps({ canShareFiles: true, embeddedBrowser: true }))).toBe('share');
    expect(receiptSaveAction(caps({ canShareFiles: true, canDownload: false }))).toBe('share');
  });

  it('downloads on a browser that has a download manager', () => {
    expect(receiptSaveAction(caps())).toBe('download');
  });

  it('never offers a download inside an app that has none', () => {
    // This is the reported defect, stated as one line: LINE's browser reports `download`
    // in `HTMLAnchorElement.prototype` and then ignores the click, so the old screen
    // looked possible and did nothing.
    expect(receiptSaveAction(caps({ embeddedBrowser: true }))).toBe('long-press');
  });

  it('falls back to press-and-hold when there is no other way to keep the picture', () => {
    expect(receiptSaveAction(caps({ canDownload: false }))).toBe('long-press');
    expect(receiptSaveAction(caps({ canDownload: false, embeddedBrowser: true }))).toBe('long-press');
  });
});

describe('recognising a page that is inside an app', () => {
  it('knows LINE on both engines', () => {
    expect(
      isEmbeddedBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Line/13.16.0',
      ),
    ).toBe(true);
    expect(
      isEmbeddedBrowser(
        'Mozilla/5.0 (Linux; Android 12; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 Line/13.16.0',
      ),
    ).toBe(true);
  });

  it('knows the social browsers a link is often opened from', () => {
    expect(isEmbeddedBrowser('Mozilla/5.0 (iPhone) Mobile/15E148 [FBAN/FBIOS;FBAV/400.0]')).toBe(true);
    expect(isEmbeddedBrowser('Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Version/4.0')).toBe(true);
    expect(isEmbeddedBrowser('Mozilla/5.0 (iPhone) Mobile/15E148 Instagram 300.0')).toBe(true);
  });

  it('does not mistake a real browser for one — Safari, Chrome, Firefox', () => {
    // A false positive costs the customer a download button they could have used, so the
    // list is short and these must all stay out of it.
    expect(
      isEmbeddedBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false);
    expect(
      isEmbeddedBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      ),
    ).toBe(false);
    expect(isEmbeddedBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0')).toBe(false);
  });
});
