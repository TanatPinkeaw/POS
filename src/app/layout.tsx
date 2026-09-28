import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Thai } from 'next/font/google';
import { cookies } from 'next/headers';

import { BRAND, THEME_COLOR } from '@/brand/brand';
import { THEME_COOKIE_NAME, parseTheme } from '@/lib/theme';

// The design system is the only stylesheet now: the generated tokens, then the
// base layer that consumes them. These two used to be ordered against the
// vendored Hope UI sheets so that an `html`-prefixed selector could win the
// cascade without `!important`; those sheets were removed in phase 5
// (docs/adr/0003-design-system.md), and the prefixes are now inert.
import '@/design/tokens.css';
import '@/design/base.css';

/*
 * Fonts are self-hosted through `next/font`, which downloads them at *build*
 * time and serves them from this origin, so a built page requests no font from
 * another host at all. The previous arrangement blocked every page load on
 * fonts.googleapis.com, and a shop with flaky internet got fallback glyphs for
 * its Thai text — a till that renders its own language wrong when the line goes
 * down is not an acceptable failure mode, and it was invisible on a developer's
 * machine.
 *
 * Removing the `@import` from the application's own stylesheet turned out to be
 * only half of the fix: the vendored theme's stylesheets carried a Google Fonts
 * `@import` of their own, which kept a third-party request in the critical path
 * until the theme was deleted outright. "No font is fetched from another origin"
 * was verified against the built output then, not assumed.
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
 * There is no stylesheet to link any more. The vendored Hope UI sheets and
 * Bootstrap's JavaScript — which together were the transitional scaffold — were
 * removed once the last screen moved onto the design system (ADR 0003), and
 * `npm run ui:audit` is what keeps them from coming back.
 *
 * Dark mode is resolved here, on the server, from a cookie, so the class is in
 * the very first byte of HTML and a dark-mode user never sees the white flash a
 * client-side toggle would cause.
 *
 * The class goes on `<body>`, not `<html>`, because that is where the tokens
 * look for it: `tokens.css` declares its dark values under `html body.dark` and
 * mirrors them onto the root with `html:has(body.dark)` so that a token read off
 * the root element agrees with the one the app inherits.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const store = await cookies();
  const theme = parseTheme(store.get(THEME_COOKIE_NAME)?.value);

  return (
    <html lang="th" className={`${inter.variable} ${thai.variable}`}>
      <body className={theme === 'dark' ? 'dark' : undefined}>{children}</body>
    </html>
  );
}
