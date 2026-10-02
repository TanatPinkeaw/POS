# The next three efforts, in order

**What this file is.** Three pieces of work are designed and one of them is finished. This
sequences them, says what each unlocks, and names which document changes with each — so the
order is a decision rather than whatever the tree happened to contain. It is a plan, not a
description of the build: `README.md` says what exists, and each ADR says why.

The three overlap in time but not in the money path: the first and third both touch it, the
second does not. That is the spine of the order below.

---

## Effort 1 — Land the offline till

**State.** Built, reviewed on both axes, and **green** when it landed: `npm run verify:all` ran
all five gates (the tree has grown since — `verify` is now 68 files and 1005 tests). It is
**landed on `main`** as its own commit (`83bacc9`), on top of the base tree.

**What it unlocks.** A shop keeps selling cash when its connection drops, with the numbers,
stock and drawer reconciled when it returns (ADR 0019, `docs/offline-till-spec.md`). Nothing
else in this roadmap depends on it — but everything afterwards is harder to review while it
sits uncommitted.

**Do first, and why.** It is the only finished work, and it is a money-path change. Landing it
before Effort 3 (also a money-path change) keeps a review able to see one money-path change at
a time instead of a union of two. The commit is the owner's decision; the recommendation is to
land it alone, reviewed, before anything is stacked on it.

**Done when.** It is on `main` as its own change, and the tree is clean.

**Documents.** None. `README.md`, `docs/offline-till-spec.md`, ADR 0019 and
`docs/renter-onboarding.md` were already updated with the behaviour.

---

## Effort 2 — Customer identity, electronic receipts, the role matrix

**State.** Designed in ADRs 0020, 0021 and 0022; specified and ticketed under
`.scratch/customer-identity/`; **in progress** — tickets 01 (the Google credential and the
OTP seam), 02 (signup and linking), 04 (the role matrix), 05 (the receipt renderer) and 06 (the
signed link and the access window) are done and on `main`, the rest unbuilt.

**What it unlocks.**

- A customer signs in with Google and a verified phone, or is enrolled at the counter — the
  phone staying the identity, the points staying whole (ADR 0020).
- A receipt is a file the customer keeps, generated from the order rather than printed and not
  stored (ADR 0021) — the shop that never buys a printer.
- Which pages a role may see becomes an explicit, deny-by-default table (ADR 0022).
- **The customer portal**, which is the screen Effort 3 needs for a consignor to see what they
  are owed.

**Order inside it.** Tickets 01 (Google and OTP), 02 (signup and linking), 04 (the role matrix),
05 (the receipt renderer) and 06 (the signed link) are done; 03 (phone change and step-up) and 08
(an owner's Google door) build on 01 and 02; the portal (07) is last, carries the `/shop`
sign-in screens, and is what Effort 3 waits on.

**Done when.** A new customer can sign up with Google and prove a phone, an existing customer
can link one without losing their points, a walk-in can leave with a receipt link, an older
bill still lists without a file, and a role reaches exactly the pages it was granted.

**Documents.** `README.md`'s *Not built yet* loses the four entries (identity, e-receipt, role
matrix, and none else); `docs/renter-onboarding.md` gains how a customer signs in and how the
receipt is delivered. The ADRs are already written.

---

## Effort 3 — Consigned goods (ฝากขาย)

**State.** Designed in ADR 0023; specified and ticketed under `.scratch/consignment/`;
**unbuilt**. Explicitly touches the money path.

**What it unlocks.** A member leaves goods with the shop; the shop sells them as principal and
owes an agreed percentage of the net, accrued as a payable and settled through the drawer or a
transfer (ADR 0023). The consigned share, not a second inventory.

**Order inside it.** The schema (01) and the pure share rule (02) first; the share recorded at
the two sale sites (04) is the heart; refund clawback (05), valuation (06) and the
never-offline rule (07) hang off it; the payout (08) and the consignor's portal view (09,
which waits on Effort 2) close it.

**Done when.** A consigned sale writes exactly one payable credit, a refund reverses it, a
payout nets it with a statement, consigned stock is outside the shop's own valuation, and an
offline till refuses a consigned product.

**Documents.** `README.md` *Not built yet* loses the consignment entry; the ADR gains the
accountant's answer if it changes the treatment.

---

## The order, and why

1. **Offline first** — it is finished, and landing it keeps each later money-path change
   reviewable on its own.
2. **Identity second** — it is the only effort that does not touch the money path, so it can
   run safely while the first is being reviewed, and it is what Effort 3's portal depends on.
3. **Consignment last** — it is a money-path change that needs both a clean tree (Effort 1)
   and the portal (Effort 2) to be complete.

The one hard edge across efforts: consignment ticket 09 needs the customer portal (identity
ticket 07). Everything else can proceed in parallel within its own effort.

---

## Blockers that are not code, and are not phases

- **PDPA.** A customer's phone, and now a Google identity, on our hardware: consent, retention,
  who may look, breach notification and a data-processing agreement. It must exist before a
  real customer's data lands, and no phase here produces it.
- **The accountant.** Effort 3's principal-versus-agent treatment and revenue recognition must
  be confirmed before a shop trades consigned goods.

## Deliberately not in this roadmap

- **The hosted multi-tenant build** (ADR 0016, `docs/hosted-release-plan.md`) — its own plan,
  and Effort 2's owner-signup ticket (08) is the only piece of it named here.
- **A second register, multiple branches, purchase orders, RTL** — `README.md`'s *Not built
  yet*, unchanged.
