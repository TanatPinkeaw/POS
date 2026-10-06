'use client';

import { useId, useState } from 'react';

import { LoginForm } from '@/components/auth/LoginForm';
import { Icon } from '@/components/ds/Icon';

import styles from '@/app/login/customer-signin.module.css';

/**
 * The staff door, folded away behind one control on the customer's screen.
 *
 * `/login` is where this deployment's QR codes, bookmarks and the proxy all send
 * people, and most of those people are customers (ADR 0029) — so the customer's two
 * doors render first and the staff form lives inside this toggle below the card.
 * `aria-expanded`/`aria-controls` are what make the fold honest to a screen reader:
 * the button announces what it opens, rather than a form silently appearing.
 *
 * `LoginForm` mounts only once open. That is not laziness for its own sake — the
 * form's identifier field carries `autoFocus`, which must fire *when a member of
 * staff asks for the form*, not on page load behind a customer's back, where it
 * would steal focus from the Google button a customer was about to press.
 */
export function StaffDoorToggle({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // useId rather than a literal: two instances of this component on one page must
  // not describe the same region.
  const panelId = useId();

  return (
    <div className={styles.staffDoor}>
      <button
        type="button"
        className={styles.staffToggle}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="user" size={16} />
        <span>พนักงานเข้างาน — เข้าสู่ระบบพนักงานที่นี่</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
      </button>

      {open ? (
        <div className={styles.staffPanel} id={panelId}>
          {/* The form first, the page's demo list (children) under it — the same
           * order the old sign-in page stacked them, demo under a rule. */}
          <LoginForm />
          {children}
        </div>
      ) : null}
    </div>
  );
}
