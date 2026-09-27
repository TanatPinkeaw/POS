import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { THEME_COOKIE_NAME, parseTheme } from '@/lib/theme';

import './globals.css';

export const metadata: Metadata = {
  title: 'POS Realtime · ระบบขายหน้าร้านและพรีออเดอร์',
  description:
    'ระบบ POS แบบเรียลไทม์ พร้อมสต็อก การจองสินค้า 4 ขั้นตอน และการจัดการกะพนักงาน',
};

/**
 * Root layout.
 *
 * Hope UI's stylesheets are linked directly rather than imported. They are
 * vendored under `public/hope-ui`, and `hope-ui.min.css` already bundles a
 * compiled Bootstrap 5 — importing Bootstrap from npm as well would load two
 * conflicting copies of the same framework.
 *
 * Dark mode is resolved here, on the server, from a cookie, so the class is on
 * `<html>` in the very first byte of HTML and a dark-mode user never sees the
 * white flash a client-side toggle would cause.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const store = await cookies();
  const theme = parseTheme(store.get(THEME_COOKIE_NAME)?.value);

  return (
    <html lang="th" className={theme === 'dark' ? 'dark' : undefined}>
      <head>
        <link rel="icon" href="/hope-ui/assets/images/favicon.ico" />
        {/* Stylesheet order matches Hope UI's own demo page. */}
        <link rel="stylesheet" href="/hope-ui/assets/css/core/libs.min.css" />
        <link rel="stylesheet" href="/hope-ui/assets/css/custom.min.css" />
        <link rel="stylesheet" href="/hope-ui/assets/css/dark.min.css" />
        <link rel="stylesheet" href="/hope-ui/assets/css/hope-ui.min.css" />
      </head>
      <body>
        {children}
        {/*
          Bootstrap's JS, vendored from Hope UI, for dropdowns, collapses,
          modals and tooltips. A plain deferred script, not next/script, so it
          lands before React hydrates the components using `data-bs-*`.
        */}
        <script src="/hope-ui/assets/js/core/libs.min.js" defer />
      </body>
    </html>
  );
}
