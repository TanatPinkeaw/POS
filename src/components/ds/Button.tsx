import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Icon } from './Icon';
import type { IconName } from './icons';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'text' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<Size, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

/**
 * A button.
 *
 * Two things it does that ad-hoc `<button className="btn btn-primary">` markup
 * cannot:
 *
 *   * **It is never smaller than the density allows.** Sizes come from
 *     `--ln-control-h*`, so the same `<Button size="md">` is a 34px control on a
 *     back office screen and a 48px one on the till — where it is used on a
 *     tablet on a counter, often one-handed, often with a wet hand.
 *   * **`loading` makes the busy state honest.** It disables the button, sets
 *     `aria-busy`, and keeps the label in place rather than swapping it for a
 *     spinner — a control whose name changes while it is working is a control a
 *     screen reader reads twice.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  icon,
  iconAfter,
  className,
  type = 'button',
  disabled,
  ...rest
}: {
  children?: ReactNode;
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
  icon?: IconName;
  iconAfter?: IconName;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = [
    styles.button,
    styles[variant],
    SIZE_CLASS[size],
    block ? styles.block : '',
    !children ? styles.iconOnly : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
      {!loading && icon ? <Icon name={icon} size={size === 'lg' ? 22 : 18} /> : null}
      {children ? <span className={styles.label}>{children}</span> : null}
      {iconAfter && !loading ? <Icon name={iconAfter} size={size === 'lg' ? 22 : 18} /> : null}
    </button>
  );
}

/**
 * A button-shaped link, for navigation that looks like an action.
 *
 * It is an `<a>` rather than a `<button>` because "go to the reports screen" must
 * be openable in a new tab, copyable, and announced as a link. Styling is shared
 * with `Button` so the two are indistinguishable on screen.
 */
export function LinkButton({
  children,
  href,
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  ...rest
}: {
  children?: ReactNode;
  href: string;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  className?: string;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const classes = [
    styles.button,
    styles[variant],
    SIZE_CLASS[size],
    !children ? styles.iconOnly : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <a {...rest} href={href} className={classes}>
      {icon ? <Icon name={icon} size={size === 'lg' ? 22 : 18} /> : null}
      {children ? <span className={styles.label}>{children}</span> : null}
    </a>
  );
}
