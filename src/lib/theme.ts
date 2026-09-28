/**
 * Colour mode.
 *
 * The server reads this cookie and puts a `dark` class on `<body>`, so the first
 * byte of HTML is already the right colour and a dark-mode user never sees a
 * white flash. The design tokens are what key off the class — `html body.dark`,
 * mirrored onto the root with `html:has(body.dark)` — which is why it lives on
 * `<body>` rather than on `<html>`.
 */

export const THEME_COOKIE_NAME = 'pos_theme';

export type Theme = 'light' | 'dark';

export function parseTheme(value: string | undefined): Theme {
  return value === 'dark' ? 'dark' : 'light';
}

export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
