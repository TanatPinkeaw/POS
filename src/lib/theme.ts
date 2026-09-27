/**
 * Colour mode.
 *
 * Hope UI expresses dark mode as a `.dark` class on the root element (every
 * rule in `dark.min.css` is scoped `.dark …`), so the class is applied to
 * `<html>` on the server from this cookie rather than by a client effect.
 */

export const THEME_COOKIE_NAME = 'pos_theme';

export type Theme = 'light' | 'dark';

export function parseTheme(value: string | undefined): Theme {
  return value === 'dark' ? 'dark' : 'light';
}

export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
