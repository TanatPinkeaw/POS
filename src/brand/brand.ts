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
 * The mark's geometry lives here rather than inside the component because two
 * very different renderers need it: React (inline SVG) and the icon generator
 * (a canvas rasteriser that produces the PNG app icons). Duplicating the path
 * data would let the favicon drift from the sidebar.
 *
 * "เหลี่ยมนอก" is literally *the square outside* — the corner that has come off
 * the box. The mark draws exactly that: a square frame whose top-right corner is
 * cut away, with the removed corner sitting just outside it.
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
 * The mark, as path data on a 40×40 grid.
 *
 * A 40-unit box with 8 units of padding keeps the detached corner inside the
 * viewBox, and the 4.2-unit diagonal offset between the frame and the corner is
 * what keeps them legible as two shapes rather than a smear at 16 px.
 */
export const MARK = {
  viewBox: '0 0 40 40',
  /** The square, missing its top-right corner: a chamfer from (24,8) to (32,16). */
  frame: 'M8 8 H24 L32 16 V32 H8 Z',
  /** The corner that came off, floating just outside that chamfer. */
  corner: 'M27 5 H35 V13 Z',
} as const;

/** Where the brand appears, so a new screen cannot pick its own answer. */
export const BRAND_SURFACES = {
  /** Product chrome: login, wizard, sidebar, admin, error pages, docs. */
  platform: true,
  /** Shop-facing documents: receipts, reprints, customer pages. */
  tenantOwned: false,
} as const;
