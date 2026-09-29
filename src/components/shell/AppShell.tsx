'use client';

/**
 * The application frame.
 *
 * Two jobs, and the second is the one that is easy to miss:
 *
 *   1. It draws the sidebar, the top bar and the account menu from the design
 *      system rather than from a vendored theme, so the frame looks the same on a
 *      screen that has been migrated and one that has not.
 *   2. **It decides the density.** `data-density` is set once, here, from the area
 *      the frame is serving — `touch` for the till, `compact` for everything
 *      else — and every component inside reads that through the token layer. This
 *      is what lets one `Button` be a 48px till target and a 34px back-office
 *      control without a single prop being threaded anywhere.
 *
 * The sidebar collapse is a class on the frame, not a library. The vendored
 * theme's `hope-ui.js` was jQuery-based and initialised on `DOMContentLoaded`,
 * which Next cannot promise for a client-rendered page — and it is gone now
 * anyway (ADR 0003), so nothing here may reintroduce a dependency on it.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { BRAND } from '@/brand/brand';
import { BrandMark } from '@/brand/BrandMark';
import { Avatar, Icon, Menu, MenuItem, MenuLabel, MenuSeparator } from '@/components/ds';
import type { IconName } from '@/components/ds';
import { activeNavHref } from '@/lib/nav-active';
import { REALTIME_EVENTS } from '@/lib/realtime-events';
import { ROLE_LABEL } from '@/lib/roles';
import { playPreOrderChime, primeAudio } from '@/lib/sound';
import { THEME_COOKIE_MAX_AGE, THEME_COOKIE_NAME, parseTheme, type Theme } from '@/lib/theme';

import { useRealtime, useRealtimeEvent } from '../realtime/RealtimeProvider';
import styles from './AppShell.module.css';

export interface NavItem {
  href: string;
  label: string;
  /** A drawn icon, not a text glyph: `☰` and `☾` render differently on every OS. */
  icon: IconName;
  /** Nav key that incoming pre-orders should badge. */
  badgedByPreOrders?: boolean;
}

export interface ShellUser {
  /** Used by screens that must tell "you" from "another account", e.g. staff. */
  id: string;
  fullName: string;
  role: 'member' | 'employee' | 'admin';
  pointsBalance: number;
  /** The shop this session belongs to, printed in the sidebar. */
  shopName: string;
}

const MINI_KEY = 'ln.sidebar.mini';

/**
 * The connection indicator.
 *
 * It is `role="status"` so that losing the socket is announced rather than merely
 * turning a dot red — on a till, the difference between "the sale is recorded" and
 * "the sale is queued until the line comes back" is the kind of thing a cashier
 * needs to be told rather than left to infer from a colour.
 */
function SocketStatus() {
  const { status } = useRealtime();
  const label =
    status === 'online'
      ? 'เชื่อมต่อแล้ว'
      : status === 'connecting'
        ? 'กำลังเชื่อมต่อ'
        : 'ขาดการเชื่อมต่อ';

  return (
    <span className={styles.socket} role="status">
      <Icon
        name={status === 'offline' ? 'wifiOff' : 'wifi'}
        size={16}
        // The colour follows the state; the icon follows it too, so the meaning
        // survives a monochrome screen and a colour-blind operator.
      />
      <span>{label}</span>
    </span>
  );
}

export function AppShell({
  user,
  nav,
  /** `touch` for the till, `compact` for the back office and the member area. */
  density = 'compact',
  /** The till hides chrome to give the selling area the whole viewport. */
  variant = 'default',
  children,
}: {
  user: ShellUser;
  nav: NavItem[];
  density?: 'compact' | 'touch';
  variant?: 'default' | 'till';
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mini, setMini] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('light');
  const [preOrderAlert, setPreOrderAlert] = useState(0);

  // The server already rendered the correct class; mirror it into state so the
  // toggle shows the right icon before the first interaction.
  useEffect(() => {
    setTheme(parseTheme(document.body.classList.contains('dark') ? 'dark' : 'light'));
    setMini(window.localStorage.getItem(MINI_KEY) === '1');
  }, []);

  // Any pointer interaction is a user gesture, and therefore the safe moment to
  // unlock audio — a browser will not let a chime play before one.
  useEffect(() => {
    const unlock = (): void => primeAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // A route change closes the phone drawer; leaving it open over the new screen
  // is how a tap on "สินค้า" appears not to have worked.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  const isStaff = user.role === 'employee' || user.role === 'admin';

  /** SRS §3 Phase 1: badge plus chime when a pre-order lands. */
  useRealtimeEvent<{ orderNumber: string }>(REALTIME_EVENTS.orderCreated, (payload) => {
    if (!isStaff) {
      return;
    }
    setPreOrderAlert((count) => count + 1);
    playPreOrderChime();
    router.refresh();

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('มีพรีออเดอร์ใหม่', { body: `ออเดอร์ ${payload.orderNumber}` });
    }
  });

  const toggleMini = useCallback(() => {
    setMini((value) => {
      const next = !value;
      window.localStorage.setItem(MINI_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.body.classList.toggle('dark', next === 'dark');
    document.cookie = `${THEME_COOKIE_NAME}=${next}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
  };

  const signOut = async (): Promise<void> => {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  };

  const onTill = variant === 'till';

  /*
   * Which item is current, worked out once for the whole nav. A per-link test cannot
   * get this right on its own: `/pos` is a prefix of `/pos/preorders`, so the till and
   * the pre-order board would both light up (and both announce themselves as the
   * current page). `activeNavHref` picks the deepest match; see its doc comment.
   */
  const activeHref = activeNavHref(
    pathname,
    nav.map((item) => item.href),
  );

  const sidebar = (
    <nav className={styles.sidebar} aria-label="เมนูหลัก">
      <Link href={nav[0]?.href ?? '/'} className={styles.brand}>
        <BrandMark size={28} title={BRAND.nameTh} />
        <span className={styles.brandText}>
          {/*
           * The shop's own name, not the product's: this is what makes the app
           * feel like the renter's system rather than one they are borrowing. The
           * platform's name lives in the account menu, where someone has
           * deliberately gone looking for it.
           */}
          <span className={styles.brandShop}>{user.shopName}</span>
          <span className={styles.brandRole}>{ROLE_LABEL[user.role]}</span>
        </span>
      </Link>

      <div className={styles.nav}>
        {nav.map((item) => {
          const active = item.href === activeHref;
          const showBadge = item.badgedByPreOrders && preOrderAlert > 0;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.link} ${active ? styles.linkActive : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                if (item.badgedByPreOrders) {
                  setPreOrderAlert(0);
                }
              }}
            >
              <span className={styles.linkIcon} aria-hidden="true">
                <Icon name={item.icon} size={18} />
              </span>
              <span className={styles.linkLabel}>{item.label}</span>
              {showBadge ? (
                /*
                 * The count is a status, not decoration: it is announced as a
                 * number of new pre-orders, not as the digit a sighted operator
                 * happens to see beside a nav item.
                 */
                <span
                  className={styles.linkBadge}
                  role="status"
                  aria-label={`พรีออเดอร์ใหม่ ${preOrderAlert} รายการ`}
                >
                  <span aria-hidden="true" className={`${styles.badge} ln-num`}>
                    {preOrderAlert}
                  </span>
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>

      <div className={styles.sidebarFooter} />
    </nav>
  );

  return (
    <div
      className={`${styles.frame} ${mini && !onTill ? styles.frameMini : ''} ${onTill ? styles.frameTill : ''}`}
      data-density={density}
    >
      {/* The first tab stop on every page: a keyboard user can jump the sidebar. */}
      <a href="#main" className="ln-skip-link">
        ข้ามไปเนื้อหาหลัก
      </a>

      <div className="ln-no-print">{sidebar}</div>

      {drawerOpen ? (
        <>
          <div className={styles.drawerScrim} onClick={() => setDrawerOpen(false)} />
          <nav className={`${styles.sidebar} ${styles.drawer}`} aria-label="เมนูหลัก">
            <Link href={nav[0]?.href ?? '/'} className={styles.brand}>
              <BrandMark size={28} title={BRAND.nameTh} />
              <span className={styles.brandText}>
                <span className={styles.brandShop}>{user.shopName}</span>
                <span className={styles.brandRole}>{ROLE_LABEL[user.role]}</span>
              </span>
            </Link>
            <div className={styles.nav}>
              {nav.map((item) => {
                const active = item.href === activeHref;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`${styles.link} ${active ? styles.linkActive : ''}`}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className={styles.linkIcon} aria-hidden="true">
                      <Icon name={item.icon} size={18} />
                    </span>
                    <span className={styles.linkLabel}>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </nav>
        </>
      ) : null}

      <div className={styles.main}>
        <header className={`${styles.topbar} ln-no-print`}>
          <div className={styles.topbarStart}>
            {/*
              * Two toggles, one of which is always hidden by a media query rather
              * than by a viewport test in JavaScript: below the breakpoint the
              * sidebar is a drawer that opens over the content, above it the
              * sidebar is permanent and only collapses to icons. Rendering the
              * wrong one for a frame is how a layout flashes on load.
              */}
            <button
              type="button"
              className={`${styles.iconButton} ${styles.drawerToggle}`}
              aria-label="เปิดเมนู"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
            >
              <Icon name="menu" size={20} />
            </button>
            <button
              type="button"
              className={`${styles.iconButton} ${styles.miniToggle}`}
              aria-label={mini ? 'ขยายเมนู' : 'ย่อเมนู'}
              aria-pressed={mini}
              onClick={toggleMini}
            >
              <Icon name={mini ? 'chevronRight' : 'arrowLeft'} size={18} />
            </button>
          </div>

          <div className={styles.topbarEnd}>
            <SocketStatus />

            <button
              type="button"
              className={styles.iconButton}
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'เปิดโหมดสว่าง' : 'เปิดโหมดมืด'}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>

            <Menu
              label="บัญชีผู้ใช้"
              trigger={
                <span className={styles.account}>
                  <Avatar name={user.fullName} size={30} />
                  <span className={styles.accountText}>
                    <span className={styles.accountName}>{user.fullName}</span>
                    <span className={styles.accountRole}>{ROLE_LABEL[user.role]}</span>
                  </span>
                </span>
              }
            >
              <MenuLabel>
                {user.fullName} · {ROLE_LABEL[user.role]}
              </MenuLabel>
              {user.role === 'member' ? (
                <MenuLabel>{user.pointsBalance.toLocaleString('en-US')} คะแนน</MenuLabel>
              ) : null}
              <MenuSeparator />
              <MenuItem icon="logOut" onSelect={() => void signOut()}>
                ออกจากระบบ
              </MenuItem>
            </Menu>
          </div>
        </header>

        <main
          id="main"
          className={`${styles.content} ${onTill ? styles.contentTill : ''}`}
          tabIndex={-1}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
