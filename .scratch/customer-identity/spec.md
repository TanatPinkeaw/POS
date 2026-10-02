# Customer identity, electronic receipts, and the role matrix

Status: ready-for-agent

Authoritative specifications:
[ADR 0020](../../docs/adr/0020-a-customer-signs-in-with-google.md) (identity),
[ADR 0021](../../docs/adr/0021-the-electronic-receipt-is-generated.md) (e-receipt),
[ADR 0022](../../docs/adr/0022-page-access-is-a-fixed-role-matrix.md) (role matrix).
Related: [ADR 0016](../../docs/adr/0016-hosted-multi-tenant.md) (hosted signup, amended by
0020), [ADR 0010](../../docs/adr/0010-member-accounts.md) /
[ADR 0011](../../docs/adr/0011-counter-enrolment.md) (counter enrolment, still supported),
[ADR 0009](../../docs/adr/0009-rate-limiting.md) /
[ADR 0012](../../docs/adr/0012-shared-rate-limit-store.md) (the limiter the OTP door joins),
[ADR 0014](../../docs/adr/0014-product-photos-are-links.md) (why no file storage exists).

## Approved scope

Three decisions that share a layer — who a customer is, what they can see, and what document
they leave with — built so that the counter never depends on any of them.

**Identity (ADR 0020).** A `member` may sign in with **Google** and prove a phone with an
**OTP**; counter enrolment is unchanged and neither door is required for the other. The
**phone stays required and unique across every role**, and points hang off it, so a first
Google sign-in **links** to the member row that already owns the number rather than creating a
second. OTP verifies once at signup and again on every phone change, never on every sign-in.
The id token is verified in-process against Google's **JWKS** with `jose`. Staff and the
owner's day-to-day stay on phone and temporary password; the owner's **signup** is a Google
door (hosted). One `users` table; one phone, one identity.

**Electronic receipts (ADR 0021).** A receipt is **generated on demand** from the order, as an
image the client draws with the Canvas API — no stored file, no object store. The order data
is kept as it is today; the customer may **download** the image for the **last month**, and
older bills stay visible without the file. A walk-in with no account gets one through a
**signed link**, the same discipline as the pickup code. One renderer is kept in step with
`Receipt.tsx` by hand, and that cost is accepted.

**Role matrix (ADR 0022).** Which pages a role may see is a **fixed, deny-by-default matrix**
in the codebase, not a setting. The starting grants: `member` → `/shop/*`; `employee` →
`/pos/*` plus read-only `/admin/dashboard` and `/admin/reports`; `admin` → everything.

Out of scope: a per-shop or per-user permission editor, multi-role identities, a separate
`customers` table, PDF receipts, and a chosen SMS provider (a seam, decided at deploy).

## Test seams

Pure where the rule is a rule: the OTP and identity-linking decisions and the receipt's
one-month access rule are pure modules with unit tests. Server behaviour against real
PostgreSQL: a Google sign-in with a member's phone **links** (one row, points intact, never a
second); a phone change without a fresh OTP is refused; a second shop's phone is unaffected;
the OTP door is rate-limited; the role matrix refuses a page the role was not granted, on the
server rather than in the menu. E-receipt: the same order renders the same image twice; the
image matches the order's figures; a signed link names exactly one order and expires; a bill
older than a month offers no file while its order stays visible. Chromium covers the Canvas
render and the signed-link download the way `offline:browser` covers the till.

## Delivery

Tickets are worked blockers-first as red/green slices, then reviewed on the Standards and Spec
axes. Nothing here touches the money path, so it does not wait on the offline work — but it
does add a customer portal, which the consignment view (`.scratch/consignment/issue 09`)
depends on. The **PDPA posture is a release blocker for a real shop** and not for the code.

## Blockers that are not code

- **PDPA.** A customer's phone, and now a Google identity, on our hardware — consent,
  retention, who may look, breach notification and a data-processing agreement (CONTEXT item 9,
  ADR 0016). Unwritten.
- **Accountant** confirmation that the receipt image is an acceptable copy of the record is
  not required here (the order is the record), but a shop that stops printing paper should
  confirm its tax posture.
