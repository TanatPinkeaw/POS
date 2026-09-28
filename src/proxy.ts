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
     * Skip the API, the websocket, and static assets.
     *
     * API routes enforce their own permissions and must answer with 401/403
     * JSON rather than a redirect to a login page.
     *
     * Assets are skipped by *shape* — a dotted name in the last segment — rather
     * than by filename. The previous list named `favicon.ico` on its own, which
     * meant the moment a browser needed something else from the root of
     * `public/` it was redirected to `/login` instead of served: exactly what
     * happened to `/manifest.webmanifest` and `/icon-192.png`, which an installing
     * browser fetches *before* anybody has signed in, and which therefore looked
     * like a broken PWA rather than a broken guard.
     *
     * This is safe: no page route in this app contains a dot, so a dotted path can
     * only ever be a missing file (a 404) or a real one from `public/`. The data
     * itself is still protected by `requireRole` in every route handler and by
     * `requireShellUser` in every layout — the point of this file is only to decide
     * which *area* an unauthenticated visitor is allowed to look at.
     */
    '/((?!_next/static|_next/image|api|realtime|uploads|.*\\.[A-Za-z0-9]+$).*)',
  ],
};
