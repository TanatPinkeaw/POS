'use client';

import { useState } from 'react';

import { renderableImageUrl } from '@/lib/image-url';

import { Icon } from './Icon';
import styles from './Thumb.module.css';

export type ThumbSize = 'sm' | 'md' | 'lg' | 'fill';

/**
 * The three fixed sizes come from density tokens (rule 4); `fill` is the one that
 * does not, because its size *is* its container — a till tile's photo fills the tile
 * and the tile's width decides how big that is.
 */
const SIZE_CLASS: Record<ThumbSize, string> = {
  sm: styles.size_sm,
  md: styles.size_md,
  lg: styles.size_lg,
  fill: styles.size_fill,
};

/**
 * A product photo, or the placeholder that stands in for one.
 *
 * Four decisions, all of them about what happens when the picture is not there —
 * because in this deployment it usually is not:
 *
 * **The placeholder is the common case, not the error case.** Most products have no
 * link at all, and once the till's and the storefront's tiles started showing photos
 * at their full width, the pictureless ones stopped being a footnote: a grid of grey
 * rectangles with the same glyph in each is what the customer and the cashier
 * actually see. So the stand-in is the product's own initial on the aisle colour its
 * category already wears — the same hue as the till tile's edge bar and the chip,
 * from the same pure mapping — and a caller that has no category at hand still gets
 * the plain `image` glyph, unchanged.
 *
 * **It is decorative.** `aria-hidden` on the whole box, and the letter is derived
 * from the same name the caller already renders as text right beside this — a name
 * announced twice is noise at a counter. The photo is a recognition aid for a scan
 * of the grid, not a second copy of the label; the same is true of the letter that
 * stands in for it.
 *
 * **It never blocks the page.** `loading="lazy"` keeps a grid of sixty tiles from
 * opening sixty connections at once, and `decoding="async"` keeps a slow decode off
 * the main thread — a shop's photo host is somebody else's server, and the till must
 * stay usable while it answers. `referrerPolicy="no-referrer"` sends nothing about
 * the shop to that host, which also gets around the hotlink protection a home NAS
 * often has switched on.
 *
 * **What is remembered is *which* link failed, not that one did.** The till's list
 * re-renders the same tile after a stock event, and a product whose link was
 * corrected must get another try.
 */
export function Thumb({
  url,
  size = 'md',
  className,
  categoryKey,
  name,
}: {
  /** Whatever the shop pasted; refused and replaced by the placeholder if unusable. */
  url: string | null | undefined;
  size?: ThumbSize;
  className?: string;
  /**
   * The aisle colour to wear when there is no photo, from `categoryColorKey` — the
   * same key the caller already puts on the till tile's edge bar and the shop's
   * chip. Optional: callers that have no category at hand keep the old neutral
   * glyph, which is the right placeholder for a shop logo or a row in a table.
   */
  categoryKey?: string;
  /**
   * The product's name, whose first grapheme becomes the stand-in letter. Spread
   * (`[...name]`) rather than indexed: code units would cut a surrogate pair in
   * half, and `.slice(0, 1)` is no better against the Thai marks that follow a base
   * consonant. Optional: without it the placeholder is the plain `image` glyph.
   */
  name?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = renderableImageUrl(url);
  const broken = src !== null && failedUrl === src;
  /* A filled photo is a recognition aid, so its placeholder is drawn at the size a
   * person notices rather than the 16 px that belongs in a table cell. */
  const iconSize = size === 'fill' ? 32 : size === 'sm' ? 16 : 20;
  const monogram = name !== undefined && name.length > 0 ? [...name][0]! : null;

  return (
    <span
      className={[styles.thumb, SIZE_CLASS[size], className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      {/*
       * The aisle wash, as its own layer rather than a background on `.thumb`: a
       * transparent PNG then shows the category colour behind it, and the empty
       * frame and the photo sit on the same ground. Painted below the photo by
       * explicit z-index, not DOM order — positioned and in-flow siblings order by
       * z-index in every engine, and a rule that reads as "probably fine" is how a
       * Safari-only regression starts here (ADR 0031).
       */}
      {categoryKey !== undefined ? <span className={styles.aisle} data-cat={categoryKey} /> : null}
      {src && !broken ? (
        <img
          className={styles.image}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(src)}
        />
      ) : monogram !== null && categoryKey !== undefined ? (
        <span className={styles.monogram} data-cat={categoryKey}>
          {monogram}
        </span>
      ) : (
        <Icon name="image" size={iconSize} />
      )}
    </span>
  );
}
