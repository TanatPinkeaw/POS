/**
 * Role-Based Access Control — SRS §2.
 *
 * Deliberately free of any Node-only imports so the middleware (which runs on
 * the edge runtime) can share exactly the same permission table as the server.
 */

export type Role = 'member' | 'employee' | 'admin';

export const ROLES: readonly Role[] = ['member', 'employee', 'admin'];

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

interface AreaPermissions {
  /** Path prefix that the rule guards. */
  prefix: string;
  roles: Role[];
}

const AREAS: AreaPermissions[] = [
  { prefix: '/admin', roles: ['admin'] },
  { prefix: '/pos', roles: ['employee', 'admin'] },
  { prefix: '/shop', roles: ROLES.slice() },
];

/**
 * The roles allowed to reach `pathname`, or null when the path is public.
 *
 * Order matters: the longest matching prefix wins, so a future
 * `/pos/reports` rule would override the broader `/pos` one.
 */
export function requiredRolesForPath(pathname: string): Role[] | null {
  let match: AreaPermissions | null = null;

  for (const area of AREAS) {
    const matches = pathname === area.prefix || pathname.startsWith(`${area.prefix}/`);
    if (matches && (match === null || area.prefix.length > match.prefix.length)) {
      match = area;
    }
  }

  return match ? match.roles : null;
}

/**
 * True when `pathname` is one of the public routes.
 *
 * `/setup` is listed here because the proxy runs on the edge runtime and cannot
 * query the database to ask whether this deployment has been configured — the
 * check that matters ("refuse once a shop exists") is made by the page and the
 * route handler, which do run on the Node runtime, with the singleton primary
 * key as the final backstop.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname === '/' ||
    pathname === '/setup' ||
    pathname.startsWith('/hope-ui/') ||
    pathname.startsWith('/uploads/')
  );
}
