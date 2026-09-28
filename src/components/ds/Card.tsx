import type { ReactNode } from 'react';

import styles from './Card.module.css';

/**
 * A surface with a title.
 *
 * `title` is rendered as an `<h2>` deliberately, not as a `<div class="h5">`. A
 * page has one `<h1>` and its sections are the level below it; screen-reader
 * users navigate by that outline, and a card whose heading is a `div` is
 * invisible to it. The visual size is controlled by the class, so the semantics
 * and the pixels are decided separately.
 */
export function Card({
  title,
  subtitle,
  actions,
  toolbar,
  children,
  footer,
  /** Removes the body padding, for a card whose content is a table. */
  flush = false,
  /** Applies the brand's cut corner. Reserved for a few large screens, not for
   * every card — a chamfer on everything is noise, and it cannot be printed
   * cleanly on thermal paper. */
  cut = false,
  className,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Filters and search, between the header and the content. */
  toolbar?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  cut?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={`${styles.card} ${cut ? 'ln-cut' : ''} ${className ?? ''}`}
    >
      {title || actions || subtitle ? (
        <header className={styles.header}>
          <div className={styles.headerText}>
            {title ? <h2 className={styles.title}>{title}</h2> : null}
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
      <div className={flush ? styles.bodyFlush : styles.body}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </section>
  );
}

/**
 * The heading of a screen: what it is, and what you can do here.
 *
 * `actions` sits beside the title on a wide screen and wraps under it on a
 * tablet, because a header that pushes its buttons off the edge is the first
 * thing to break when a shop buys a smaller device.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div className={styles.pageHeaderText}>
        {breadcrumb ? <div className={styles.breadcrumb}>{breadcrumb}</div> : null}
        <h1 className={styles.pageTitle}>{title}</h1>
        {subtitle ? <p className={styles.pageSubtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.pageActions}>{actions}</div> : null}
    </header>
  );
}

/** Lays out cards in a responsive grid without any screen deciding the widths. */
export function CardGrid({
  children,
  /** Minimum column width before the grid drops to fewer columns. */
  min = '18rem',
}: {
  children: ReactNode;
  min?: string;
}) {
  return (
    <div className={styles.grid} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}, 1fr))` }}>
      {children}
    </div>
  );
}
