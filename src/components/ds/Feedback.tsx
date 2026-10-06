import type { ReactNode } from 'react';

import { Icon } from './Icon';
import type { IconName } from './icons';
import styles from './Feedback.module.css';

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'brand';

const TONE_ICON: Record<Tone, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'warning',
  brand: 'info',
};

/**
 * The busy shape on its own: three concentric polygons turning at three speeds.
 *
 * A primitive rather than a private detail of `Spinner`, because two controls need
 * it without any words — a button that is working, and a screen that has not painted
 * yet — and two copies of three `clip-path` polygons are two shapes that can drift
 * apart. It is the same argument that keeps the mark's geometry in one string.
 *
 * Decorative by construction (`aria-hidden`), so it always travels with a label:
 * `Spinner` supplies one, and `Button` keeps its own name visible while it works.
 */
export function Loader() {
  /*
   * Three spans, and that is deliberate rather than decorative markup: each ring's
   * strength is an `opacity`, which is the only alpha `currentColor` can carry on a
   * browser without `color-mix()` (ADR 0031), and an element's opacity would reach
   * the other two rings if they were nested inside it. `Feedback.module.css` says
   * the same thing from the other side.
   */
  return (
    <span className={styles.loader} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function Spinner({ label = 'กำลังโหลด…' }: { label?: string }) {
  return (
    <span className={styles.spinnerRow} role="status">
      <Loader />
      <span className={styles.spinnerLabel}>{label}</span>
    </span>
  );
}

/**
 * A message that belongs to the page rather than to a field.
 *
 * The tone picks the live region, which is the part that matters: a failure
 * interrupts (`role="alert"`, assertive) while a confirmation waits for a pause
 * (`role="status"`, polite). A "saved" toast that interrupts an operator
 * mid-instruction is a bug, not a courtesy.
 */
export function InlineNotice({
  tone = 'info',
  title,
  children,
  actions,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const assertive = tone === 'danger' || tone === 'warning';

  return (
    <div
      className={`${styles.notice} ${styles[`notice_${tone}`]}`}
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
    >
      <span className={styles.noticeIcon} aria-hidden="true">
        <Icon name={TONE_ICON[tone]} size={18} />
      </span>
      <div className={styles.noticeBody}>
        {title ? <p className={styles.noticeTitle}>{title}</p> : null}
        {children ? <div className={styles.noticeText}>{children}</div> : null}
        {actions ? <div className={styles.noticeActions}>{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * What a screen shows when there is nothing to show.
 *
 * Always offers a way out when there is one: an empty catalogue without an
 * "import" button is a dead end, and the empty state is the only place a new
 * renter sees that button before they have any data.
 */
export function EmptyState({
  icon = 'box',
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        <Icon name={icon} size={28} strokeWidth={1.5} />
      </span>
      <p className={styles.emptyTitle}>{title}</p>
      {description ? <p className={styles.emptyText}>{description}</p> : null}
      {action ? <div className={styles.emptyAction}>{action}</div> : null}
    </div>
  );
}

/**
 * A placeholder that holds the shape of what is loading.
 *
 * Preferred over a spinner where the layout is known, because the page does not
 * jump when the data lands and the operator can start reading the structure
 * before the numbers arrive.
 */
export function Skeleton({
  width = '100%',
  height = 16,
  radius = 'var(--ln-radius-sm)',
}: {
  width?: string | number;
  height?: string | number;
  radius?: string;
}) {
  return (
    <span
      className={styles.skeleton}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}

/** A stack of skeleton lines, for a table or list that is still loading. */
export function SkeletonRows({ rows = 4, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className={styles.skeletonBlock} aria-hidden="true">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div className={styles.skeletonRow} key={rowIndex}>
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} width={columnIndex === 0 ? '30%' : 'auto'} />
          ))}
        </div>
      ))}
    </div>
  );
}
