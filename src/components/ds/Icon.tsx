import { ICON_PATHS, type IconName } from './icons';

/**
 * One icon, inline.
 *
 * Accessibility is decided by `label`, not by the caller remembering to: an icon
 * with no label is decoration and is hidden from assistive technology, while one
 * with a label becomes an image with a name. Getting that wrong is how a nav
 * ends up announcing "cart cart cart" to a screen reader.
 *
 * `strokeWidth` is exposed because the same geometry has to work at 16 px in a
 * table and at 32 px in an empty state; a 2px stroke is right at the small size
 * and spindly at the large one.
 */
export function Icon({
  name,
  size = 20,
  strokeWidth = 1.8,
  label,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  /** Supply only when the icon carries meaning no adjacent text conveys. */
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : 'presentation'}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
