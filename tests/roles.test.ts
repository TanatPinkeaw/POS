// Seam under test: the edge proxy's permission table.
//
// Worth its own file because the failure mode is silent in either direction: a path
// that should be public but is not sends a visitor to a login page, and a path that
// should be closed but is not is a page nobody intended to open. The customer display
// is the first kind of mistake — it has no account to sign in with — and a page missing
// from the matrix is the second, which is why "no rule" is asserted to mean *nobody*
// rather than *everybody* (ADR 0022).
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

  it('makes the customer door public, but only the door itself', () => {
    // `/shop` is how somebody with no account gets one (ADR 0020 §3), so it cannot
    // require a session — yet its siblings, and the account behind it, stay guarded.
    expect(isPublicPath('/shop')).toBe(true);
    expect(isPublicPath('/shop/account')).toBe(false);
    expect(isPublicPath('/shop/products')).toBe(false);
  });

  it('makes a receipt link public, because a walk-in has no session', () => {
    // ADR 0021 §3: the signed token in the query is the credential, so the page must
    // be reachable without signing in — and its siblings are unaffected.
    expect(isPublicPath('/receipts')).toBe(true);
    expect(isPublicPath('/receipts/abc')).toBe(false);
  });
});

describe('the page matrix', () => {
  it('keeps the back office to an admin, except the two read pages', () => {
    expect(requiredRolesForPath('/admin/products')).toEqual(['admin']);
    expect(requiredRolesForPath('/admin/settings')).toEqual(['admin']);
    expect(requiredRolesForPath('/admin/audit')).toEqual(['admin']);
    expect(requiredRolesForPath('/admin/members')).toEqual(['admin']);
  });

  it('opens the dashboard and the reports to an employee, read-only', () => {
    expect(requiredRolesForPath('/admin/dashboard')).toEqual(['admin', 'employee']);
    expect(requiredRolesForPath('/admin/reports')).toEqual(['admin', 'employee']);
  });

  it('picks the longest matching prefix, so the exception beats its area', () => {
    expect(requiredRolesForPath('/admin/dashboard')).toContain('employee');
    expect(requiredRolesForPath('/admin/members')).not.toContain('employee');
  });

  it('lets cashiers and admins reach the till', () => {
    expect(requiredRolesForPath('/pos')).toEqual(['employee', 'admin']);
  });

  it('guards a sub-path by the same rule as its area', () => {
    expect(requiredRolesForPath('/pos/preorders')).toEqual(['employee', 'admin']);
  });

  it('leaves the customer area open to every signed-in role', () => {
    expect(requiredRolesForPath('/shop/products')).toEqual(['member', 'employee', 'admin']);
  });

  it('keeps the customer account to a member, and by no other role', () => {
    expect(requiredRolesForPath('/shop/account')).toEqual(['member']);
    expect(requiredRolesForPath('/shop/account')).not.toContain('employee');
    expect(requiredRolesForPath('/shop/account')).not.toContain('admin');
  });

  it('denies a path no rule claims rather than opening it', () => {
    // The whole point of a matrix over directory layout: a page nobody placed is
    // reachable by nobody, so it cannot leak by omission.
    expect(requiredRolesForPath('/nowhere')).toEqual([]);
    expect(requiredRolesForPath('/nowhere')).not.toContain('admin');
    expect(requiredRolesForPath('/admin/newpage')).toEqual(['admin']);
  });
});

describe('post-login landing', () => {
  it('sends each role to an area it is allowed to open', () => {
    for (const role of ['member', 'employee', 'admin'] as const) {
      const home = homePathForRole(role);
      expect(requiredRolesForPath(home)).toContain(role);
    }
  });
});
