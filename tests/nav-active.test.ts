/**
 * Which nav item a path is on.
 *
 * The case at the bottom is the bug this exists for: the till's nav lists `/pos` and
 * `/pos/preorders`, and the obvious implementation lit up both of them on the
 * pre-order board — two items marked current, and two `aria-current="page"` in the
 * same nav.
 */
import { describe, expect, it } from 'vitest';

import { activeNavHref } from '@/lib/nav-active';

const TILL = ['/pos', '/pos/preorders', '/pos/attendance'];
const ADMIN = ['/admin/dashboard', '/admin/products', '/admin/staff', '/pos', '/pos/preorders'];

describe('activeNavHref', () => {
  it('finds the item a path is exactly', () => {
    expect(activeNavHref('/pos', TILL)).toBe('/pos');
    expect(activeNavHref('/pos/preorders', TILL)).toBe('/pos/preorders');
  });

  it('lights the deepest item when one route nests under another', () => {
    // The whole point: on the pre-order board, only the pre-order board is current.
    expect(activeNavHref('/pos/preorders', TILL)).toBe('/pos/preorders');
    expect(activeNavHref('/pos/attendance', TILL)).toBe('/pos/attendance');
  });

  it('keeps a child route on its parent item', () => {
    expect(activeNavHref('/pos/preorders/abc123', TILL)).toBe('/pos/preorders');
    expect(activeNavHref('/admin/products/import', ADMIN)).toBe('/admin/products');
  });

  it('matches a whole path segment, not a string prefix', () => {
    expect(activeNavHref('/pos-other', TILL)).toBeNull();
    expect(activeNavHref('/position', TILL)).toBeNull();
  });

  it('answers null rather than guessing, when the nav lists nothing for the path', () => {
    expect(activeNavHref('/shop/products', TILL)).toBeNull();
    expect(activeNavHref('/', TILL)).toBeNull();
    expect(activeNavHref('/anything', [])).toBeNull();
  });

  it('picks one item out of the manager admin nav, where the till is listed too', () => {
    expect(activeNavHref('/admin/dashboard', ADMIN)).toBe('/admin/dashboard');
    expect(activeNavHref('/pos/preorders', ADMIN)).toBe('/pos/preorders');
    expect(activeNavHref('/pos', ADMIN)).toBe('/pos');
  });
});
