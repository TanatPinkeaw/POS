'use client';

/**
 * The application shell, built from Hope UI's own sidebar and navbar markup.
 *
 * The sidebar collapse is handled here rather than by Hope UI's bundled
 * `hope-ui.js`: that script is jQuery-based and initialises on DOMContentLoaded,
 * which Next cannot guarantee for a client-hydrated page. Toggling the
 * `sidebar-mini` class is the whole behaviour, and `hope-ui.min.css` already
 * styles it (`.sidebar.sidebar-mini { --sidebar-width: 4.8rem }`).
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { playPreOrderChime, primeAudio } from '@/lib/sound';
import { THEME_COOKIE_MAX_AGE, parseTheme, THEME_COOKIE_NAME, type Theme } from '@/lib/theme';
import { REALTIME_EVENTS } from '@/lib/realtime-events';

import { useRealtime, useRealtimeEvent } from '../realtime/RealtimeProvider';

export interface NavItem {
  href: string;
  label: string;
  /** Shown as a small leading glyph. Kept as text so no icon font is needed. */
  glyph: string;
  /** Nav key that incoming pre-orders should badge. */
  badgedByPreOrders?: boolean;
}

export interface ShellUser {
  fullName: string;
  role: 'member' | 'employee' | 'admin';
  pointsBalance: number;
}

const ROLE_LABEL: Record<ShellUser['role'], string> = {
  admin: 'ผู้จัดการ',
  employee: 'พนักงาน',
  member: 'สมาชิก',
};

function SocketStatus() {
  const { status } = useRealtime();

  const tone = status === 'online' ? 'success' : status === 'connecting' ? 'warning' : 'danger';
  const label =
    status === 'online' ? 'เชื่อมต่อแล้ว' : status === 'connecting' ? 'กำลังเชื่อมต่อ' : 'ขาดการเชื่อมต่อ';

  return (
    <span className={`d-flex align-items-center gap-1 small text-${tone}`} title={label}>
      <span
        className={`bg-${tone} rounded-circle d-inline-block`}
        style={{ width: 8, height: 8 }}
        aria-hidden="true"
      />
      <span className="d-none d-lg-inline">{label}</span>
    </span>
  );
}

export function AppShell({
  user,
  nav,
  children,
}: {
  user: ShellUser;
  nav: NavItem[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mini, setMini] = useState(false);
  const [theme, setTheme] = useState<Theme>('light');
  const [preOrderAlert, setPreOrderAlert] = useState(0);

  // The server already rendered the correct class; mirror it into state so the
  // toggle button shows the right icon on first paint.
  useEffect(() => {
    setTheme(parseTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  }, []);

  // Any nav click is a user gesture, so it is the safe moment to unlock audio.
  useEffect(() => {
    const unlock = (): void => primeAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  const isStaff = user.role === 'employee' || user.role === 'admin';

  /** SRS §3 Phase 1: badge plus chime when a pre-order lands. */
  useRealtimeEvent<{ orderNumber: string }>(REALTIME_EVENTS.orderCreated, (payload) => {
    if (!isStaff) {
      return;
    }
    setPreOrderAlert((count) => count + 1);
    playPreOrderChime();
    // Refresh server-rendered counts without a full navigation.
    router.refresh();

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('มีพรีออเดอร์ใหม่', { body: `ออเดอร์ ${payload.orderNumber}` });
    }
  });

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    document.cookie = `${THEME_COOKIE_NAME}=${next}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
  };

  const signOut = async (): Promise<void> => {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  };

  return (
    <>
      <aside className={`sidebar sidebar-default sidebar-white sidebar-base navs-rounded-all ${mini ? 'sidebar-mini' : ''}`}>
        <div className="sidebar-header d-flex align-items-center justify-content-between">
          <Link href={nav[0]?.href ?? '/'} className="navbar-brand">
            <div className="logo-main">
              <div className="logo-normal">
                <svg className="text-primary icon-30" width="30" height="30" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="-0.76" y="19.24" width="28" height="4" rx="2" transform="rotate(-45 -0.76 19.24)" fill="currentColor" />
                  <rect x="7.73" y="27.73" width="28" height="4" rx="2" transform="rotate(-45 7.73 27.73)" fill="currentColor" />
                  <rect x="10.54" y="16.39" width="16" height="4" rx="2" transform="rotate(45 10.54 16.39)" fill="currentColor" />
                  <rect x="10.56" y="-0.56" width="28" height="4" rx="2" transform="rotate(45 10.56 -0.56)" fill="currentColor" />
                </svg>
              </div>
            </div>
            <h4 className="logo-title mb-0">POS Realtime</h4>
          </Link>
          <div
            className="sidebar-toggle"
            role="button"
            tabIndex={0}
            aria-label="ย่อ/ขยายเมนู"
            onClick={() => setMini((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setMini((value) => !value);
              }
            }}
          >
            <i className="icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4.25 12.27L19.25 12.27" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10.3 18.3L4.25 12.27L10.3 6.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </i>
          </div>
        </div>

        <div className="sidebar-body pt-0">
          <div className="sidebar-list">
            <ul className="navbar-nav iq-main-menu" id="sidebar-menu">
              {nav.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const showBadge = item.badgedByPreOrders && preOrderAlert > 0;

                return (
                  <li className="nav-item" key={item.href}>
                    <Link
                      href={item.href}
                      className={`nav-link ${active ? 'active' : ''}`}
                      onClick={() => {
                        if (item.badgedByPreOrders) {
                          setPreOrderAlert(0);
                        }
                      }}
                    >
                      <i className="icon fs-5" aria-hidden="true">
                        {item.glyph}
                      </i>
                      <span className="item-name">{item.label}</span>
                      {showBadge && (
                        <span className="badge bg-danger rounded-pill ms-2">{preOrderAlert}</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="sidebar-footer" />
      </aside>

      <main className="main-content">
        <div className="position-relative iq-banner">
          <nav className="nav navbar navbar-expand-lg navbar-light iq-navbar">
            <div className="container-fluid navbar-inner">
              <div
                className="sidebar-toggle d-lg-none"
                role="button"
                tabIndex={0}
                aria-label="เปิดเมนู"
                onClick={() => setMini((value) => !value)}
                onKeyDown={() => undefined}
              >
                <i className="icon" aria-hidden="true">
                  ☰
                </i>
              </div>

              <div className="d-flex align-items-center gap-3 ms-auto">
                <SocketStatus />

                <button
                  type="button"
                  className="btn btn-sm btn-soft-primary"
                  onClick={toggleTheme}
                  aria-label="สลับโหมดสว่าง/มืด"
                  title={theme === 'dark' ? 'โหมดสว่าง' : 'โหมดมืด'}
                >
                  {theme === 'dark' ? '☀' : '☾'}
                </button>

                {user.role === 'member' && (
                  <span className="badge bg-soft-warning text-warning">
                    {user.pointsBalance.toLocaleString('en-US')} คะแนน
                  </span>
                )}

                <div className="nav-item dropdown">
                  <a
                    href="#user-menu"
                    className="nav-link d-flex align-items-center gap-2"
                    id="user-menu"
                    role="button"
                    data-bs-toggle="dropdown"
                    aria-expanded="false"
                  >
                    <span className="d-flex align-items-center justify-content-center rounded-circle bg-soft-primary text-primary fw-bold"
                      style={{ width: 32, height: 32 }}
                      aria-hidden="true"
                    >
                      {user.fullName.trim().charAt(0)}
                    </span>
                    <span className="d-none d-md-inline">
                      <span className="d-block small fw-medium">{user.fullName}</span>
                      <span className="d-block text-muted" style={{ fontSize: '0.72rem' }}>
                        {ROLE_LABEL[user.role]}
                      </span>
                    </span>
                  </a>
                  <ul className="dropdown-menu dropdown-menu-end" aria-labelledby="user-menu">
                    <li>
                      <button type="button" className="dropdown-item" onClick={() => void signOut()}>
                        ออกจากระบบ
                      </button>
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </nav>
        </div>

        <div className="container-fluid content-inner py-4">{children}</div>
      </main>
    </>
  );
}
