'use client';

import type { ReactNode } from 'react';

import { Button } from './Button';
import { Icon } from './Icon';
import styles from './Layout.module.css';

/**
 * Two panes with one of them holding its width.
 *
 * This is the till's whole shape: the bill on one side at a fixed width — because
 * a bill that grows as items are added makes the product grid jump under the
 * operator's finger — and the catalogue taking everything else. Below the
 * breakpoint it becomes one column, and `stackOrder` decides which half comes
 * first, because on a phone the answer is not the same as on a tablet: you pick
 * the item first and look at the total second.
 */
export function SplitPane({
  panel,
  children,
  panelWidth = '23rem',
  side = 'start',
  stackOrder = 'content-first',
  /** Fills the parent's height, for panes that scroll internally. */
  fill = false,
  label,
}: {
  /** The fixed-width pane. */
  panel: ReactNode;
  /** The flexible pane. */
  children: ReactNode;
  panelWidth?: string;
  side?: 'start' | 'end';
  stackOrder?: 'panel-first' | 'content-first';
  fill?: boolean;
  /** Landmark name, announced when the panes are navigated as regions. */
  label?: string;
}) {
  return (
    <div
      className={styles.split}
      data-side={side}
      data-stack={stackOrder}
      data-fill={fill ? 'true' : undefined}
      style={{ '--split-panel': panelWidth } as React.CSSProperties}
    >
      <div className={styles.splitPanel} role={label ? 'region' : undefined} aria-label={label}>
        {panel}
      </div>
      <div className={styles.splitContent}>{children}</div>
    </div>
  );
}

/** A vertical stack with consistent gaps, so screens stop inventing `mb-3`. */
export function Stack({
  children,
  gap = 'md',
  className,
}: {
  children: ReactNode;
  gap?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={`${styles.stack} ${styles[`gap_${gap}`]} ${className ?? ''}`}>{children}</div>
  );
}

/** A row of controls: filters on the left, actions on the right. */
export function Toolbar({
  children,
  actions,
  className,
}: {
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.toolbar} ${className ?? ''}`}>
      <div className={styles.toolbarMain}>{children}</div>
      {actions ? <div className={styles.toolbarActions}>{actions}</div> : null}
    </div>
  );
}

/**
 * The search box, which on a till is also the barcode target.
 *
 * The scanner is a keyboard that types a code and presses Enter, so a search field
 * that is focused is a working scanner, and one that has lost focus is a silently
 * broken one. That is why the caller is handed the ref: refocusing after a sale is
 * part of the contract, not an optimisation.
 */
export function SearchField({
  id,
  value,
  onChange,
  onSubmit,
  placeholder,
  label,
  inputRef,
  mono = false,
  autoFocus = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  label: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /** Monospace, for a field that receives a barcode rather than a search term. */
  mono?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={styles.search}>
      <label className="ln-visually-hidden" htmlFor={id}>
        {label}
      </label>
      <span className={styles.searchIcon} aria-hidden="true">
        <Icon name="search" size={18} />
      </span>
      <input
        id={id}
        ref={inputRef}
        className={`${styles.searchInput} ${mono ? 'ln-mono' : ''}`}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && onSubmit) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {value ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label="ล้างคำค้นหา"
          className={styles.searchClear}
          onClick={() => onChange('')}
        >
          <Icon name="close" size={16} />
        </Button>
      ) : null}
    </div>
  );
}

/** An operator's initials, so a screen can say *who* did something compactly. */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      className={styles.avatar}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {name.trim().charAt(0)}
    </span>
  );
}

/**
 * A breadcrumb that is a real navigation list, so a screen reader announces "list,
 * three items" and each crumb is a link rather than a slash-separated string.
 */
export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="เส้นทาง">
      <ol className={styles.breadcrumb}>
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className={styles.crumb}>
            {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}
            {index < items.length - 1 ? (
              <span className={styles.crumbSep} aria-hidden="true">
                <Icon name="chevronRight" size={14} />
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Pagination, with the page count spelled out.
 *
 * "หน้า 3 จาก 12" is the part that matters on a shop's report: `‹ ›` alone tells an
 * operator nothing about how far in they are, and a report is something people
 * read off a screen while talking to someone.
 */
export function Pagination({
  page,
  pageCount,
  onPageChange,
  totalLabel,
}: {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  totalLabel?: string;
}) {
  if (pageCount <= 1) {
    return totalLabel ? <p className={styles.paginationTotal}>{totalLabel}</p> : null;
  }

  return (
    <nav className={styles.pagination} aria-label="แบ่งหน้า">
      {totalLabel ? <p className={styles.paginationTotal}>{totalLabel}</p> : null}
      <div className={styles.paginationButtons}>
        <Button
          variant="secondary"
          size="sm"
          icon="arrowLeft"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          ก่อนหน้า
        </Button>
        <span className={styles.paginationPage} aria-live="polite">
          หน้า {page} จาก {pageCount}
        </span>
        <Button
          variant="secondary"
          size="sm"
          iconAfter="arrowRight"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          ถัดไป
        </Button>
      </div>
    </nav>
  );
}
