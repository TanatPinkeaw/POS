# 04: A fixed, deny-by-default page matrix

**What to build:** Which pages a role may see is one explicit table, enforced on the server.

**Blocked by:** None.
**Status:** done

- [x] One matrix in the codebase mapping each page/area to the roles allowed, deny by default.
- [x] `src/proxy.ts` consults it for routing; `requireRole` consults it for the handler — the
      two places access is already decided, with no third gate.
- [x] Starting grants: `member` → `/shop/*`; `employee` → `/pos/*` plus read-only
      `/admin/dashboard` and `/admin/reports`; `admin` → everything.
- [x] A page absent from the matrix is unreachable rather than public.
- [x] Tests: each role reaches exactly its grant and nothing else, asserted through the server
      (not by reading a menu); an employee's `POST` to an admin route is refused even though
      the dashboard is readable.

## Continuation checkpoint

The matrix is `PAGES` in `src/lib/roles.ts`, read by `rolesForPage` / `requiredRolesForPath`
(deny by default: a path no rule claims resolves to the empty role list) and by
`canReachPage`, which the nav and a screen can share with the guard. `src/proxy.ts` now
refuses when `requiredRolesForPath` does not include the role, so a page left out of the
matrix is refused rather than opened by omission. The admin area admits an **employee** for
its two read pages: the `(admin)` layout requires `['admin', 'employee']` and hands an
employee a filtered `EMPLOYEE_NAV`, while `products`, `schedules` and `settings` each call
`requireShellUser(['admin'])` themselves, and `audit`/`members`/`staff` already did.

Covered by `tests/roles.test.ts` (10 cases): the exceptions beat their area by longest prefix,
an employee is granted the dashboard and reports and refused the rest of `/admin`, and
`/nowhere` resolves to no role rather than to everybody.

Verified on the current tree: `npm run typecheck` clean, `tests/roles.test.ts` and
`tests/nav-active.test.ts` pass, and `npm run verify:all` is green across all five gates
(route audit 23/23, offline browser 21 checks).

**One honesty note.** The handler half of the last box is enforced by the matrix lookup and
by each page's `requireShellUser`, but there is **no server-level test** that signs in as an
employee and asserts the redirect on `/admin/products` and the 403 on an admin API — the
suites run against the library and a scratch schema, not the HTTP surface. The unit tests and
the route audit cover the matrix and the rendering; the through-HTTP assertion is a gap to
close when a loop that drives pages with a real session exists.

Source: ../spec.md and ../../../docs/adr/0022-page-access-is-a-fixed-role-matrix.md.
