'use client';

import type { ReactNode } from 'react';

import styles from './Tabs.module.css';

export interface TabItem {
  key: string;
  label: ReactNode;
  /** A count or short figure shown beside the label, e.g. how many are waiting. */
  badge?: ReactNode;
}

/**
 * A tab list that is a tab list.
 *
 * The reference design uses a horizontal band of categories to switch what the
 * selling grid is showing, and the reason to build it properly is keyboard
 * behaviour: `role="tablist"` with ArrowLeft/ArrowRight and a single tab stop for
 * the whole group. A row of `<button>`s with an `active` class looks identical and
 * forces a keyboard user through every category to reach the one after the row.
 *
 * `variant="underline"` is for a screen that already has a card border (the tabs
 * then read as part of the card's header); `variant="segmented"` is for a filter
 * that floats on the canvas, including the till's category rail.
 */
export function Tabs({
  items,
  value,
  onChange,
  variant = 'underline',
  label,
  /** Horizontal scroll instead of wrapping — a rail of twenty aisles on a tablet. */
  scroll = false,
}: {
  items: TabItem[];
  value: string;
  onChange: (key: string) => void;
  variant?: 'underline' | 'segmented';
  /** Accessible name for the group; required because "tabs" is not a name. */
  label: string;
  scroll?: boolean;
}) {
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
      return;
    }
    event.preventDefault();
    const index = items.findIndex((item) => item.key === value);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = items[(index + step + items.length) % items.length];
    if (next) {
      onChange(next.key);
      // Focus follows selection, which is what makes arrow keys feel like a radio
      // group rather than like a scroll.
      event.currentTarget
        .querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(next.key)}"]`)
        ?.focus();
    }
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={[
        styles.list,
        variant === 'segmented' ? styles.segmented : styles.underline,
        scroll ? styles.scroll : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            data-key={item.key}
            aria-selected={selected}
            /* One tab stop for the group; the arrows move within it. */
            tabIndex={selected ? 0 : -1}
            className={`${styles.tab} ${selected ? styles.selected : ''}`}
            onClick={() => onChange(item.key)}
          >
            <span className={styles.tabLabel}>{item.label}</span>
            {item.badge !== undefined && item.badge !== null ? (
              <span className={styles.badge}>{item.badge}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
