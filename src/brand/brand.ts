/**
 * เหลี่ยมนอก · Liam Nong — the platform's brand, in one place.
 *
 * This is the product a renter runs, not the shop it serves. The distinction
 * matters everywhere: this name belongs on the login screen, the wizard, the
 * sidebar and the error pages, and it must **never** appear on a receipt, a
 * customer-facing catalogue, or anything else a shop's own customer reads. Those
 * surfaces carry the renter's identity, which is why `shops` exists at all
 * (ADR 0002).
 *
 * The mark lives here rather than inside the component because two very
 * different consumers need it: React, which draws the artwork on every platform
 * surface, and the icon generator, which resamples the same file into the PNG
 * app icons. Naming it once is what stops the tab icon drifting from the sidebar.
 *
 * The name answers **วงใน** (WongNai) — *the in-crowd*, the circle a shop is
 * either inside or outside of. เหลี่ยมนอก is the square that stands outside
 * that circle: outside the frame, and square about it. The rules that concept
 * imposes on every screen — sharp edges, the outsider voice, and where the
 * name may appear — are written down in `docs/brand.md`.
 *
 * "เหลี่ยมนอก" is literally *the square outside* — the corner that has come off
 * the box. The name still means that; the mark no longer draws it, because the
 * mark is the artwork the shop supplied (ADR 0015). The name is copy and the mark
 * is a picture, so the two are allowed to say different things — what they may not
 * do is disagree by accident, which is why the file is one constant rather than a
 * path string in one component and a filename in a script.
 */

export const BRAND = {
  /** The name as a Thai speaker writes it. Used in prose and titles. */
  nameTh: 'เหลี่ยมนอก',
  /** The Latin wordmark, for places that need a non-Thai lockup. */
  nameEn: 'Liam Nong',
  /** How the name is pronounced, for the one place a reader may not know it. */
  pronunciation: 'เหลี่ยม-นอก · lìam nɔ̂ːk',
  taglineTh: 'ระบบขายหน้าร้านสำหรับร้านที่ไม่ได้อยู่ในกรอบ',
  taglineEn: 'Point of sale for shops that do not fit the mould',
  description:
    'ระบบขายหน้าร้าน สต็อก พรีออเดอร์ และพนักงาน แบบเรียลไทม์ ที่ร้านเป็นเจ้าของเอง',
  /** Latin-only description, used in `metadata` for non-Thai crawlers. */
  descriptionEn:
    'A self-hosted realtime point of sale with atomic inventory, four-phase pre-orders, staff shifts and Thai tax receipts.',
} as const;

/**
 * The brand palette: seven chosen colours, lightest first.
 *
 * The lightest of them is also the ground the app mark is drawn on where a surface
 * is dark (`--ln-brand-plate`, ADR 0015), and the plate of every app icon — the
 * artwork's ink is a deep olive, so it needs a light ground the way the old
 * white-on-olive icon needed a dark one.
 *
 * `npm run brand:palette` writes these into the 50–600 steps of the ramp verbatim
 * and derives only the three steps below them, so changing the brand is an edit to
 * this list and never a hunt through stylesheets.
 *
 * Olive through to salmon rather than the indigo this replaced. The palette is a
 * hue sweep — a green that ripens into a warm coral as it lightens — because the
 * three colours that already carry meaning on a till screen are green (money in),
 * amber (attention) and red (money out); a brand that sits between them can never
 * be mistaken for a status, and the deep end stays dark enough to be the primary
 * fill with white text on it.
 *
 * The order here is the palette, not the ramp: the ramp sorts these by measured
 * luminance, which puts `#fa8072` between `#c5b380` and `#8e8e54`. That reordering
 * is deliberate and load-bearing — a ramp whose steps do not get monotonically
 * lighter is a ramp that cannot be used for a hover state.
 */
export const BRAND_ANCHORS = [
  '#fbdab2',
  '#fbbf93',
  '#fba17d',
  '#c5b380',
  '#fa8072',
  '#8e8e54',
  '#556b2f',
] as const;

/**
 * The primary colour: the deepest anchor, and the colour of an action.
 *
 * Kept as a named export because plenty of places need *a* brand colour rather
 * than a scale — the app icons, the browser chrome — and they should not have to
 * know which step is the primary one.
 */
export const BRAND_SEED = '#556b2f';

/** The colour a mobile browser paints its chrome with, per scheme. */
export const THEME_COLOR = { light: BRAND_SEED, dark: '#12131C' } as const;

/**
 * The mark, as the artwork file itself.
 *
 * 500×500 PNG, RGBA, committed in `public/` — the supplied Pictorial Mark, with
 * its shading intact. Its content is a screen with the letter drawn on it in a
 * light tone, and that is why it is a raster: the letter has no outline of its own
 * to trace, so any one-colour vector of this picture is a silhouette that loses
 * the letter outright (ADR 0015).
 *
 * The two fields are one string in two forms — a URL for the browser, a path for
 * the icon generator — because a commit that changes one and not the other is the
 * drift this constant exists to prevent. `file` is derived so it cannot be.
 */
const MARK_SRC = '/brand-mark.png';

export const MARK = {
  /** What the browser asks for. */
  src: MARK_SRC,
  /** The same file on disk, for `npm run brand:icons`. */
  file: `public${MARK_SRC}`,
} as const;

/** Where the brand appears, so a new screen cannot pick its own answer. */
export const BRAND_SURFACES = {
  /** Product chrome: login, wizard, sidebar, admin, error pages, docs. */
  platform: true,
  /** Shop-facing documents: receipts, reprints, customer pages. */
  tenantOwned: false,
} as const;
