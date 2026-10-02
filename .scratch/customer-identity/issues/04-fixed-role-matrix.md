# 04: A fixed, deny-by-default page matrix

**What to build:** Which pages a role may see is one explicit table, enforced on the server.

**Blocked by:** None.
**Status:** ready-for-agent

- [ ] One matrix in the codebase mapping each page/area to the roles allowed, deny by default.
- [ ] `src/proxy.ts` consults it for routing; `requireRole` consults it for the handler — the
      two places access is already decided, with no third gate.
- [ ] Starting grants: `member` → `/shop/*`; `employee` → `/pos/*` plus read-only
      `/admin/dashboard` and `/admin/reports`; `admin` → everything.
- [ ] A page absent from the matrix is unreachable rather than public.
- [ ] Tests: each role reaches exactly its grant and nothing else, asserted through the server
      (not by reading a menu); an employee's `POST` to an admin route is refused even though
      the dashboard is readable.

## Notes

A hidden menu item is a courtesy; the refusal is the server's (ADR 0022 §3). Adding a role
touches every guard on purpose — that is what makes it a decision.
