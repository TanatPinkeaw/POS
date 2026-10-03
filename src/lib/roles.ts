/**
 * Role-Based Access Control — SRS §2.
 *
 * Deliberately free of any Node-only imports so the middleware (which runs on
 * the edge runtime) can share exactly the same permission table as the server.
 */

export type Role = 'member' | 'employee' | 'admin';

export const ROLES: readonly Role[] = ['member', 'employee', 'admin'];

/**
 * The one Thai spelling of each role.
 *
 * Kept here rather than repeated per screen: this vocabulary gets printed in the
 * sidebar, on the roster and inside a refusal message, and three copies of a
 * word is how one screen ends up calling an admin a "ผู้ดูแลระบบ" and another a
 * "ผู้จัดการ" for the same account.
 */
export const ROLE_LABEL: Record<Role, string> = {
  member: 'สมาชิก',
  employee: 'พนักงาน',
  admin: 'ผู้จัดการ',
};

/** Cashiers, floor staff, inventory clerks. */
export function isStaff(role: Role): boolean {
  return role === 'employee' || role === 'admin';
}

/** Product CRUD, pricing, categories, image upload — admin only. */
export function canManageCatalog(role: Role): boolean {
  return role === 'admin';
}

/** POS checkout, pre-order phases, stock adjustments, cash drawer. */
export function canOperatePos(role: Role): boolean {
  return isStaff(role);
}

/** Schedules, attendance administration, dashboards, exports. */
export function canAdminister(role: Role): boolean {
  return role === 'admin';
}

/** Void and refund approval — admin only. */
export function canApproveVoids(role: Role): boolean {
  return role === 'admin';
}

/**
 * Where a user lands after signing in.
 *
 * Sign-in redirects to a role-specific home rather than honouring an arbitrary
 * `next` parameter, so a member can never be bounced into the POS terminal.
 */
export function homePathForRole(role: Role): string {
  switch (role) {
    case 'admin':
      return '/admin/dashboard';
    case 'employee':
      return '/pos';
    case 'member':
      return '/shop/products';
  }
}

interface PagePermission {
  /** Path prefix that the rule guards. */
  prefix: string;
  roles: Role[];
}

/**
 * The page matrix — who may reach which page (ADR 0022).
 *
 * **Deny by default.** A path with no rule here is reachable by nobody, so a new
 * screen is invisible until it is deliberately placed. That is the whole point of
 * a matrix over "the files happen to live under this folder": adding a page is a
 * decision, not an accident of where somebody put it.
 *
 * Order does not matter to the lookup — the **longest matching prefix** wins — but
 * the list is written widest-last so a reader sees the exceptions above their
 * area: `/admin/dashboard` and `/admin/reports` open to an employee (read-only),
 * while the rest of `/admin` stays closed to them.
 */
const PAGES: PagePermission[] = [
  { prefix: '/admin/dashboard', roles: ['admin', 'employee'] },
  { prefix: '/admin/reports', roles: ['admin', 'employee'] },
  { prefix: '/admin', roles: ['admin'] },
  { prefix: '/pos', roles: ['employee', 'admin'] },
  /*
   * The customer portal — points, receipts and the phone change — is the customer's
   * own account, and only theirs (ADR 0020, ticket 07). It sits above `/shop` so the
   * longest-prefix rule makes it member-only while the catalogue and order screens
   * keep the wider access they already had.
   */
  { prefix: '/shop/account', roles: ['member'] },
  { prefix: '/shop', roles: ROLES.slice() },
];

/**
 * The roles allowed to reach `pathname`, or null when no rule grants it.
 *
 * Null is distinct from an empty list here only for the caller's benefit: the
 * entries exported below collapse it, because "no rule" and "nobody" are the same
 * answer — a refusal.
 */
export function rolesForPage(pathname: string): Role[] | null {
  let match: PagePermission | null = null;

  for (const page of PAGES) {
    const matches = pathname === page.prefix || pathname.startsWith(`${page.prefix}/`);
    if (matches && (match === null || page.prefix.length > match.prefix.length)) {
      match = page;
    }
  }

  return match ? match.roles : null;
}

/**
 * The roles required for `pathname`; an empty list when nothing grants it.
 *
 * Public paths are filtered out earlier by `isPublicPath`, so a non-public path
 * with no rule is a **refusal** rather than a pass. The proxy relies on exactly
 * this: an unplaced page must not be open to everybody by omission.
 */
export function requiredRolesForPath(pathname: string): Role[] {
  return rolesForPage(pathname) ?? [];
}

/**
 * Whether `role` may reach `pathname`.
 *
 * The one predicate the nav and a screen can share with the guard, so a menu item
 * and the route it points at cannot disagree about who may see it.
 */
export function canReachPage(role: Role, pathname: string): boolean {
  return requiredRolesForPath(pathname).includes(role);
}

/**
 * True when `pathname` is one of the public routes.
 *
 * `/setup` is listed here because the proxy runs on the edge runtime and cannot
 * query the database to ask whether this deployment has been configured — the
 * check that matters ("refuse once a shop exists") is made by the page and the
 * route handler, which do run on the Node runtime, with the singleton primary
 * key as the final backstop.
 *
 * `/display` is listed for the same reason as `/login`: the screen standing at
 * the counter has no account to sign into. Guarding it here would send a shop's
 * customer display to a login page it can never satisfy. What actually protects
 * it is not this list — it is that the page shows nothing until it has a device
 * token an admin issued minutes earlier, and that every fact it receives comes
 * from the whitelist in `display-view.ts`.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/' ||
    pathname === '/setup' ||
    pathname === '/display' ||
    /*
     * The shop's privacy notice. Public because of who it is for rather than what it
     * holds: a notice a walk-in with no account cannot read is not notice, and the
     * point of asking a customer for a phone number at `/shop` is void if the answer
     * sits behind the door that phone number opens. Exact, like `/shop`.
     */
    pathname === '/privacy' ||
    /*
     * The customer's own door (ADR 0020 §3): `/shop` is the screen a person with no
     * account reaches to become one, so it cannot itself require a session. It is
     * exact, not a prefix — `/shop/products` and the rest of the area stay guarded.
     */
    pathname === '/shop' ||
    /*
     * The customer's receipt, opened from a signed link (ADR 0021 §3): a walk-in has
     * no session, and the token in the query is the credential. Without this the proxy
     * would send them to a login they cannot satisfy. The route handler and the page
     * still verify the token; being reachable is not being authorised.
     */
    pathname === '/receipts' ||
    pathname.startsWith('/uploads/')
  );
}
