# ADR 0022 — Page access is a fixed role matrix

**Status:** accepted (2026-10-02).

**Context.** Every screen already belongs to an **Area** (`admin`, `pos`, `shop`, public)
and every handler authorises with `requireRole`; `src/proxy.ts` routes between the areas.
What the ask adds is the explicit requirement that *which pages a role may see* is a decided
thing rather than a consequence of where the files happen to live — a role must not reach a
page it was not granted.

The temptation is to make this configurable: let a shop tick which pages each role sees, or
grant a person extra pages. Both turn a fixed, auditable fact into shop-managed state that
can be configured into a hole — a shop that hides the payment page from the only role that
can open a drawer, or that grants a cashier the audit trail. This decision refuses that
until a real shop asks for it.

## Decisions

### 1. Three roles, one fixed matrix, deny by default

The roles stay `admin`, `employee`, `member`. A page is reachable by a role only if the
matrix grants it; anything not granted is denied, so a new page is invisible until it is
deliberately placed. The matrix is data in the codebase, reviewed like any other change —
not a setting.

### 2. The default grants, to start

- **`member`** — `/shop/*` only.
- **`employee`** — `/pos/*`, plus **read-only** `/admin/dashboard` and `/admin/reports`.
- **`admin`** — every page.

This matches what the areas do today, so enforcing it changes behaviour for nobody who is
using the system honestly; it makes the boundary explicit rather than incidental.

### 3. Enforced in the two places that already exist

The matrix is consulted where access is already decided: `src/proxy.ts` for the routing
question and `requireRole` in the handlers for the authorisation question. No second gate,
no client-side hiding as the enforcement.

## Consequences

- **Adding a page means placing it in the matrix** — one deliberate line instead of inheriting
  visibility from a directory.
- **A new role is a broad change** on purpose: it touches every guard, which is what makes
  adding one a decision rather than a config edit.
- **Client-side navigation hides nothing.** A hidden menu item is a courtesy; the refusal is
  the server's.

## Rejected

- **Per-shop configurable matrix.** A setting a shop can get wrong on day one, for a problem
  no shop has reported.
- **Per-user overrides.** An access model with two dimensions to reason about, and the one
  that produces "why can't I see this page?" support calls.
- **Row-level or field-level permissions.** Not asked for, and a much larger model.

## Known gaps

- **The matrix is not yet written as code.** Today's enforcement is the area routing and
  `requireRole` as they stand; the explicit table is this ADR's decision and is unbuilt.
