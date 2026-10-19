# ADR 0034 — A receipt on a phone is something to read, not a file to save

**Status:** accepted (2026-10-19). **Amends ADR 0021 §3** (the customer's receipt as a
generated image behind a link), and **ADR 0024** (the till's service worker scope, §2 below).

**Context.** The shop's own phone produced two reports in one hour, and only one of them was
a CSS problem.

The receipts tab at `/shop/account` had a button labelled `ดาวน์โหลด`. Behind it was
`receiptImageDataUrl` → a Blob → `document.createElement('a')` with `download` set →
`click()`. That is the textbook way to save a generated picture, and it is exactly right in a
browser with a download manager. The shop's customers open this page **inside LINE**, whose
in-app browser is a `WKWebView` with no download handling at all: the click is not refused, it
is *ignored*. Nothing happened, nothing was said, and the customer had no way to tell a broken
page from a tap that did not register. The one screen that could have explained it explained
nothing.

The second report — the storefront rendering as white cards the height of the screen — turned
out to be the product tile's photo deciding the tile's height (`aspect-ratio` on the frame plus
`height: 100%` on an in-flow `<img>`). That is not a receipt question, but it is the same
question about a phone: **which engine answered, and did anything measure it?** It is recorded
here because the two fixes are the same shape — move a decision out of a browser's discretion
and into code that can be tested.

## Decisions

### 1. The row opens the slip; saving it is a second, explicit act

The receipts tab now opens the receipt **in the app** (an `Overlay` around the same `Receipt`
component the till prints and the public link draws). A customer can read the figure they were
charged — and check it — before any question about keeping it comes up. The old screen asked a
customer to save a document they had never been shown.

### 2. How the picture leaves is one pure decision, and the browser's limits are an input

`src/lib/receipt-save.ts` answers with one of three mechanisms, from three facts it is given:

| Answer | When | What the customer sees |
| --- | --- | --- |
| `share` | `navigator.canShare({ files })` | the system share sheet — "บันทึกไปยังรูปภาพ", "Save to Files" |
| `download` | `download` in `HTMLAnchorElement.prototype`, **and not an embedded browser** | a saved PNG |
| `long-press` | neither | the slip drawn as an `<img>` with one instruction: press and hold |

The functions are pure and take their capabilities as arguments (`receiptSaveAction`,
`isEmbeddedBrowser`), so each answer is a unit test (`tests/receipt-save.test.ts`) rather than a
belief about somebody's phone. The impure probe lives beside them
(`browserReceiptCapabilities`) so the two screens that offer a receipt — `/shop/account` and
`/receipts?t=` — cannot disagree about what the same browser can do.

**A download inside an embedded browser is not a fallback, it is the bug.** That is why
`embeddedBrowser` vetoes `download` outright instead of trying it and hoping: the failure mode
is silence, so a fallback that fails silently is worse than one that says "press and hold".

### 3. Press and hold is a real mechanism, not a shrug

Where neither sharing nor downloading exists, the dialog and the public receipt page draw the
PNG itself. iOS turns a long press on an image into the same save sheet, so the last resort is
still a working path — and the sentence under it says which one, in the customer's language.

### 4. The till's service worker is scoped to `/pos`

`public/sw.js` is served from the site root and was registered with `scope: '/'`, which is the
whole origin. The worker passed everything it does not manage straight through, so this was
correct — and it still asked every browser that had ever opened the till to run a cash-drawer
worker over the storefront, the back office and the public receipt page for as long as that
browser lived. The scope is now `/pos` (`src/lib/offline-shell.ts`), the four prepared screens
are inside it, and `tests/offline-shell.test.ts` holds the worker's own route list against that
constant so a future route cannot be listed as offline-ready outside the fence.

## Alternatives rejected

- **Hide the download button on iOS.** The platform is not the question — the *host app* is
  (`WKWebView` on any iOS app behaves the same), and a user-agent test on "is this iOS" would
  still offer the button inside LINE. Testing the capability answers it directly.
- **Always share when `navigator.share` exists.** A share sheet that cannot take a file opens
  with nothing attached; the probe has to be `canShare({ files: [...] })`, with a real `File`.
- **Store the PNG server-side and send a link.** That is ADR 0021's rejected alternative and it
  is rejected for the same reason it was then: a stored copy is a second source of truth that
  can disagree with the order, and this deployment deliberately holds no files it would have to
  back up.
- **Keep the button and add a sentence on failure.** A `download` that is ignored fires no
  event, so there is no failure to detect; the sentence would have to be shown to everyone,
  which is the same as replacing the button.

## What this does not prove

- **No gate here is a phone.** `npm run shop:phone` measures the storefront and this dialog at
  414×736 in WebKit and Chromium, including a LINE user agent for the receipt, and Playwright's
  WebKit is not iOS 15.6. The mechanism choice is proven; the host app's own behaviour on the
  shop's device is still a thing a person has to look at.
- **A cancelled share and a failed share are one `catch`.** `AbortError` is treated as the
  customer changing their mind, and anything else prints one sentence. Which of those a given
  browser throws is not measured here.
- **The image renderer is the canvas one** (`src/lib/receipt-image.ts`), so the press-and-hold
  path has the same "two renderers kept in step by hand" cost ADR 0021 §4 already records.
