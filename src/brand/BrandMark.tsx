/**
 * The เหลี่ยมนอก mark and wordmark.
 *
 * An `<img>` rather than the inline SVG this was, because the mark *is* a picture:
 * a shaded screen with the letter drawn on it in a light tone, which is not
 * something one filled path can describe (ADR 0015 — the trace that stood in for
 * it kept the highlight and lost the letter). Sizing it here and pointing it at a
 * same-origin file keeps the sidebar, the tab icon and the installed icon on one
 * description of the mark, which is why `MARK` is read from `./brand` rather than
 * a filename typed into this file.
 *
 * `Thumb` (`src/components/ds/Thumb.tsx`) is the primitive for a shop's own
 * *content* images: it lazy-loads, and it falls back to a placeholder icon when a
 * photo URL dies. Neither behaviour belongs on a mark that is above the fold and
 * ships with the app, so this is a plain `<img>` with a stylesheet for the one
 * thing a raster needs and geometry did not — the ground under it.
 */
import { BRAND, MARK } from './brand';

import styles from './BrandMark.module.css';

export function BrandMark({
  size = 30,
  /**
   * The accessible name. Left out where the mark sits beside the name in text,
   * which is decoration: a screen reader announcing the product twice is worse
   * than it saying nothing.
   */
  title,
  className,
}: {
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    <img
      className={`${styles.mark} ${className ?? ''}`}
      src={MARK.src}
      width={size}
      height={size}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
    />
  );
}

/**
 * Mark plus name. The mark is the product the shop runs on and the name beside it
 * is the product's own, which is the one place the two are allowed to be the same
 * thing.
 */
export function Wordmark({
  size = 30,
  showEnglish = false,
  className,
}: {
  size?: number;
  showEnglish?: boolean;
  className?: string;
}) {
  return (
    <span className={`ln-lockup ${className ?? ''}`}>
      <BrandMark size={size} />
      <span className="ln-lockup-text">
        <span className="ln-lockup-name">{BRAND.nameTh}</span>
        {showEnglish ? <span className="ln-lockup-sub">{BRAND.nameEn}</span> : null}
      </span>
    </span>
  );
}
