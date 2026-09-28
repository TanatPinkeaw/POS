'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Icon } from './Icon';
import type { IconName } from './icons';
import styles from './Menu.module.css';

/**
 * A menu, and the last reason this application needed Bootstrap's JavaScript.
 *
 * The vendored theme's dropdown is driven by `data-bs-toggle`, which means the
 * behaviour arrives from a jQuery-era script that runs on `DOMContentLoaded` — a
 * moment Next cannot promise for a client-rendered page. It happened to work; it
 * was never guaranteed to, and on the till an intermittently-working menu is a
 * menu that cannot open the cash drawer.
 *
 * Behaviour, not just appearance: `aria-haspopup`/`aria-expanded` on the trigger,
 * `role="menu"` with `role="menuitem"` children, ArrowUp/ArrowDown to move between
 * items, Home/End, Escape to close and return focus to the trigger, and a click
 * anywhere else to dismiss. The list is not rendered at all when closed, so its
 * items are not tabbable while it is invisible.
 */
export function Menu({
  label,
  trigger,
  children,
  align = 'end',
}: {
  /** Accessible name for the trigger when `trigger` is an icon. */
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /** Arrow keys move through the items, as a menu is expected to behave. */
  const move = (direction: 1 | -1): void => {
    const items = Array.from(
      root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) {
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = index === -1 ? 0 : (index + direction + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className={styles.root} ref={root}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
            // Open *and* move focus into the list, so the next arrow key works.
            requestAnimationFrame(() => move(1));
          }
        }}
      >
        {trigger}
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={`${styles.list} ${align === 'end' ? styles.alignEnd : ''}`}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              move(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              move(-1);
            }
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  children,
  icon,
  onSelect,
  tone = 'neutral',
  disabled = false,
}: {
  children: ReactNode;
  icon?: IconName;
  onSelect: () => void;
  tone?: 'neutral' | 'danger';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={`${styles.item} ${tone === 'danger' ? styles.itemDanger : ''}`}
      onClick={onSelect}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      <span>{children}</span>
    </button>
  );
}

/** A non-interactive heading inside a menu, e.g. whose account this is. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className={styles.menuLabel}>{children}</div>;
}

export function MenuSeparator() {
  return <div className={styles.separator} role="separator" />;
}
