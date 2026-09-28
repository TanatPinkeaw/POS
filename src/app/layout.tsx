import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai } from 'next/font/google';
import { cookies } from 'next/headers';

import { BRAND, THEME_COLOR } from '@/brand/brand';
import { THEME_COOKIE_NAME, parseTheme } from '@/lib/theme';

// The design system first, then the Hope UI bridge and whatever is left of the
// Bootstrap-era overrides. Order matters: see the cascade note in tokens.css.
import '@/design/tokens.css';
import '@/design/base.css';
import './globals.css';

/*
 * Fonts are self-hosted through `next/font`, which downloads them at *build*
 * time and serves them from this origin. The previous arrangement — an `@import`
 * of fonts.googleapis.com in globals.css — meant every page load blocked on a
 * third party, and a shop with flaky internet got fallback glyphs for its Thai
 * text. A till that renders its own language wrong when the line goes down is not
 * an acceptable failure mode, and it was invisible on a developer's machine.
 *
 * Inter covers Latin (digits, in Latin shops and on receipts) and Noto Sans Thai
 * covers Thai, including the tone marks that a Latin-only stack clips. Both are
 * OFL.
 */
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});

const thai = Noto_Sans_Thai({
  subsets: ['thai'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-thai',
  display: 'swap',
});

/**
 * The vendored theme, linked rather than imported.
 *
 * These four sheets are the transitional scaffold the design system replaces
 * screen by screen, and they are listed here — in one place, with the phase that
 * deletes them named — because dropping them by accident is silent: the markup
 * still compiles, the classes are still in the JSX, and every screen that has not
 * been migrated yet simply renders unstyled. That happened once during this
 * migration and was only caught by looking at a screen rather than at its computed
 * custom properties, which is why the list is in one file with a comment instead
 * of spread across layouts.
 *
 * Removed in phase 5 (see docs/adr/0003-design-system.md), together with the
 * `--bs-primary` bridge in tokens.css and the Bootstrap JS below.
 */
const LEGACY_THEME_SHEETS = [
  '/hope-ui/assets/css/core/libs.min.css',
  '/hope-ui/assets/css/custom.min.css',
  '/hope-ui/assets/css/dark.min.css',
  '/hope-ui/assets/css/hope-ui.min.css',
] as const;

export const metadata: Metadata = {
  // `template` is what makes every screen's own title read "… · เหลี่ยมนอก"
  // rather than repeating the brand by hand in twenty files.
  title: {
    default: `${BRAND.nameTh} — ${BRAND.taglineTh}`,
    template: `%s · ${BRAND.nameTh}`,
  },
  applicationName: BRAND.nameTh,
  description: BRAND.description,
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: BRAND.nameTh, statusBarStyle: 'default' },
  // A phone number on a page is not a link to dial it; shop phone numbers are
  // data, and iOS's auto-detection turns them into links that swallow taps.
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

/**
 * The browser chrome colour follows the *actual* theme, which is a cookie rather
 * than `prefers-color-scheme` — this app decides its theme on the server, so a
 * media query here would paint the wrong colour for anyone whose OS setting and
 * in-app setting disagree.
 */
export async function generateViewport(): Promise<Viewport> {
  const store = await cookies();
  const theme = parseTheme(store.get(THEME_COOKIE_NAME)?.value);

  return {
    themeColor: theme === 'dark' ? THEME_COLOR.dark : THEME_COLOR.light,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    width: 'device-width',
    initialScale: 1,
  };
}

/**
 * Root layout.
 *
 * Hope UI's stylesheets are still linked directly rather than imported. They are
 * vendored under `public/hope-ui`, and `hope-ui.min.css` already bundles a
 * compiled Bootstrap 5 — importing Bootstrap from npm as well would load two
 * conflicting copies of the same framework. They are on their way out: the
 * design system in `src/design/` is what replaces them, screen by screen.
 *
 * Dark mode is resolved here, on the server, from a cookie, so the class is in
 * the very first byte of HTML and a dark-mode user never sees the white flash a
 * client-side toggle would cause.
 *
 * The class goes on `<body>`, not `<html>`. Hope UI expresses dark mode as
 * `.dark { color: …; background-color: #151824 !important }` — a rule that
 * paints the element carrying the class — while `hope-ui.min.css` sets
 * `--bs-body-bg: #F5F6FA` on `body` itself. Putting the class on `<html>` left
 * `body` painting its own light background over the dark one, which is how
 * dark cards ended up floating on a light page. The design tokens key their dark
 * values off the same class, so both systems agree.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const store = await cookies();
  const theme = parseTheme(store.get(THEME_COOKIE_NAME)?.value);

  return (
    <html lang="th" className={`${inter.variable} ${thai.variable}`}>
      <head>
        {LEGACY_THEME_SHEETS.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
      </head>
      <body className={theme === 'dark' ? 'dark' : undefined}>
        {/*
          Bootstrap's JS, vendored from Hope UI, for dropdowns, collapses,
          modals and tooltips. A plain deferred script, not next/script, so it
          lands before React hydrates the components using `data-bs-*`. Exactly
          one component still needs it (the user menu in the app shell); when
          that is replaced, this tag and the vendored assets go with it.
        */}
        <script src="/hope-ui/assets/js/core/libs.min.js" defer />
        {children}
      </body>
    </html>
  );
}
