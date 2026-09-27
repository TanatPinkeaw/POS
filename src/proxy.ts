/**
 * Route guard — SRS §2.
 *
 * Next 16 replaced the `middleware.ts` convention with `proxy.ts`, and the
 * exported function has to be named `proxy` (or be a default export).
 *
 * This is coarse, edge-side protection: it decides which *area* a signed-in user
 * may open, using the shared permission table in `roles.ts`. It is deliberately
 * not the security boundary for data — every route handler independently calls
 * `requireRole`, because a proxy matcher is easy to widen by accident and must
 * never be the only thing standing between a member and the till.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { homePathForRole, isPublicPath, requiredRolesForPath } from './lib/roles';
import { SESSION_COOKIE_NAME, verifySessionToken } from './lib/session-token';

function redirectToLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return redirectToLogin(request);
  }

  let role: 'member' | 'employee' | 'admin';
  try {
    const user = await verifySessionToken(token);
    role = user.role;
  } catch {
    return redirectToLogin(request);
  }

  const required = requiredRolesForPath(pathname);
  if (required && !required.includes(role)) {
    // Send them to the area they *can* use rather than to a dead-end 403.
    const url = request.nextUrl.clone();
    url.pathname = homePathForRole(role);
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Skip static assets and the API. API routes enforce their own permissions
     * and must answer with 401/403 JSON rather than a redirect to a login page.
     */
    '/((?!_next/static|_next/image|api|realtime|hope-ui|uploads|favicon.ico).*)',
  ],
};
