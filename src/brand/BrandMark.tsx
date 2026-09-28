/**
 * The เหลี่ยมนอก mark and wordmark.
 *
 * Inline SVG rather than a font icon or an image file, for three reasons that all
 * come from the rest of this codebase: the app must render offline, it must not
 * pull an icon dependency for two shapes, and `currentColor` means the mark takes
 * the surrounding text colour — including in dark mode — with no second asset.
 *
 * The geometry is read from `./brand` so the sidebar, the favicon and the app
 * icons cannot disagree about what the mark is.
 */
import { BRAND, MARK } from './brand';

export function BrandMark({
  size = 30,
  /** Draws a solid plate behind the mark — for app icons and dark surfaces. */
  plate = false,
  plateColor,
  title,
  className,
}: {
  size?: number;
  plate?: boolean;
  plateColor?: string;
  title?: string;
  className?: string;
}) {
  /** The colour the mark is cut out of a plate in. */
  const knockout = '#ffffff';

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={MARK.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {plate ? <rect x="0" y="0" width="40" height="40" rx="9" fill={plateColor ?? 'currentColor'} /> : null}
      {/*
       * Plated: the same two shapes, knocked out of a brand plate. Both are drawn
       * in the knockout colour rather than in the plate colour, so the chip of
       * corner that sits *outside* the frame still reads at 16 px — a plate-coloured
       * triangle on a plate-coloured background is an invisible shape.
       */}
      {plate ? (
        <>
          <path
            d={MARK.frame}
            stroke={knockout}
            strokeWidth="3"
            strokeLinejoin="round"
            fill="none"
          />
          <path d={MARK.corner} fill={knockout} />
        </>
      ) : (
        <>
          <path
            d={MARK.frame}
            stroke="currentColor"
            strokeWidth="3"
            strokeLinejoin="round"
            fill="none"
          />
          <path d={MARK.corner} fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * Mark plus name. The sidebar shows this on wide viewports and collapses to the
 * mark alone when it is a rail.
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
