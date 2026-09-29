'use client';

import { useState } from 'react';

import { renderableImageUrl } from '@/lib/image-url';

import { Icon } from './Icon';
import styles from './Thumb.module.css';

export type ThumbSize = 'sm' | 'md' | 'lg' | 'fill';

/**
 * The three fixed sizes come from density tokens (rule 4); `fill` is the one that
 * does not, because its size *is* its container — a till tile's photo fills the tile
 * and the tile's own width decides how big that is.
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
 * Three decisions, all of them about what happens when the picture is not there —
 * because in this deployment it usually is not:
 *
 * **The placeholder is the common case, not the error case.** Most products have no
 * link at all, and a shop that never fills one in must get a plain `image` glyph
 * rather than a broken-image box on every tile. So a missing link and a link that
 * fails to load resolve to the same thing, and the failure is handled in the browser
 * (`onError`) rather than assumed from the string. What is remembered is *which* link
 * failed, not that one did: the till's list re-renders the same tile after a stock
 * event, and a product whose link was corrected must get another try.
 *
 * **It is decorative.** `alt=""` and `aria-hidden` are deliberate: every caller
 * renders the product's name as text right beside this, so a name announced twice is
 * noise at a counter. The photo is a recognition aid for a scan of the grid, not a
 * second copy of the label.
 *
 * **It never blocks the page.** `loading="lazy"` keeps a grid of sixty tiles from
 * opening sixty connections at once, and `decoding="async"` keeps a slow decode off
 * the main thread — a shop's photo host is somebody else's server, and the till must
 * stay usable while it answers. `referrerPolicy="no-referrer"` sends nothing about
 * the shop to that host, which also gets around the hotlink protection a home NAS
 * often has switched on.
 */
export function Thumb({
  url,
  size = 'md',
  className,
}: {
  /** Whatever the shop pasted; refused and replaced by the placeholder if unusable. */
  url: string | null | undefined;
  size?: ThumbSize;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const src = renderableImageUrl(url);
  const broken = src !== null && failedUrl === src;
  /* A filled photo is a recognition aid, so its placeholder is drawn at the size a
   * person notices rather than the 16 px that belongs in a table cell. */
  const iconSize = size === 'fill' ? 32 : size === 'sm' ? 16 : 20;

  return (
    <span
      className={[styles.thumb, SIZE_CLASS[size], className].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
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
      ) : (
        <Icon name="image" size={iconSize} />
      )}
    </span>
  );
}
