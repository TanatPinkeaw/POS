// Seam under test: the edge proxy's permission table.
//
// Worth its own file because the failure mode is silent in the other direction:
// a path that should be public but is not sends a visitor to a login page, and a
// login page that redirects back is a blank screen rather than an error. The
// customer display is exactly such a path — it has no account to sign in with —
// so it is asserted here rather than discovered on a shop floor.
import { describe, expect, it } from 'vitest';

import { homePathForRole, isPublicPath, requiredRolesForPath } from '@/lib/roles';

describe('public paths', () => {
  it('lets an unauthenticated screen reach the pages that have no account', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/setup')).toBe(true);
    expect(isPublicPath('/display')).toBe(true);
  });

  it('does not make the till or the back office public', () => {
    expect(isPublicPath('/pos')).toBe(false);
    expect(isPublicPath('/admin/dashboard')).toBe(false);
    expect(isPublicPath('/shop/products')).toBe(false);
  });
});

describe('area permissions', () => {
  it('keeps the back office to admins', () => {
    expect(requiredRolesForPath('/admin/audit')).toEqual(['admin']);
  });

  it('lets cashiers and admins reach the till', () => {
    expect(requiredRolesForPath('/pos')).toEqual(['employee', 'admin']);
  });

  it('guards a sub-path by the same rule as its area', () => {
    expect(requiredRolesForPath('/pos/preorders')).toEqual(['employee', 'admin']);
  });

  it('returns null for a path no area claims', () => {
    expect(requiredRolesForPath('/nowhere')).toBeNull();
  });
});

describe('post-login landing', () => {
  it('sends each role to an area it is allowed to open', () => {
    for (const role of ['member', 'employee', 'admin'] as const) {
      const home = homePathForRole(role);
      const required = requiredRolesForPath(home);
      expect(required === null || required.includes(role)).toBe(true);
    }
  });
});
