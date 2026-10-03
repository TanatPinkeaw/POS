# 08: Pay a consignor, with a statement

**What to build:** An admin settles what the shop owes a consignor, by drawer or transfer,
leaving a statement and an audit row.

**Blocked by:** 04.
**Status:** done

- [x] A payout debits the ledger by the amount paid and cannot exceed the balance owed.
- [x] Money leaves only through an open drawer or the shop's own banking app, recorded the way
      a refund leg already is — never an automatic transfer.
- [x] A payout produces a **statement** (the sales it covers and the amount) and an audit row.
- [x] If a payout is recorded with no drawer open, it is refused as a cash refund would be.
- [x] Tests: a payout nets the balance to zero; an over-payment is refused; a payout with no
      drawer open is refused; the statement and the ledger agree.

## Notes

Money leaving the till already has a rule (ADR 0004): out of an open drawer, or by hand in the
banking app. A payout follows it, and the statement is what turns a number into an agreed
settlement. A Thai shop pays by transfer, so the transfer leg is the common case.

## What was built

**Schema.** `consignor_payouts` — one row per settlement: consignor, `method` (reusing
`payment_method`), a positive `amount_thb`, a nullable `shift_id`, a note, `created_by` and
`created_at`. A CHECK ties the shift to the method (cash has one, a transfer has none), by the
same rule a refund leg follows. `consignor_payables` gains `payout_id`, and the
`chk_consignor_payables_payout` CHECK makes the link and the kind agree — the ledger's `payout`
debit always names its statement, and no other kind does, so money can never leave the ledger
without the paper behind it. `cash_shifts` gained the columns the drawer needs to count payouts
out (see below). Migration `prisma/migrations/20260122000000_consignment_payouts/`.

**The writer.** `src/lib/consignment-payout.ts` — `payConsignor(db, input)` validates the method
and a positive amount, looks up the consignor, computes the balance, `assertPayable` refuses an
amount above it, and for cash requires an open `cash_shifts` row (else `ConflictError` with the
Thai message a cash refund gives). Then, in one transaction, it writes the `consignor_payouts`
row, the `consignor_payables` debit (`kind: 'payout'`, negative amount, `payout_id`) and the
`consignment_paid` audit row (method, amount, balance before and after, the shift for cash). The
same module carries the read side: `consignorBalance`, `listConsignorPositions`,
`listConsignorLedger`, `getConsignorPosition`, `loadPayoutStatement` (the statement's `lines` are
the sale and refund movements between this payout and the previous one, with the opening balance,
the amount, and the balance it closes at), and `listPayoutsFor`.

**The route.** `POST /api/v1/consignors/[id]/payouts` — admin-only (`withApi` +
`requireRole(['admin'])`), body validated by `consignmentPayoutSchema`, run inside
`prisma.$transaction`.

**The screen.** `/admin/consignors` lists the balances owed and gives each consignor an account
and a payout form; a payout's statement is reachable from that page (`?consignor=…&statement=…`).
A single list route rather than an `[id]` subtree, so `route:audit` can walk it — a detail path
needs an id the audit has no way to invent.

**The drawer.** `cash-shifts.ts` / `shifts.ts`: `closeShift` now reports `cashPayoutsThb` and
subtracts cash payouts in `expectedCashThb`, so a payout taken from the till reconciles at close
the way a cash refund does.

**Docs.** `README.md` (test counts, the consignment entry), `docs/roadmap.md` (Effort 3 state),
this ADR's *Known gaps*.

## Continuation checkpoint

Ticket 09 — the consignor's own view of what they are owed from the customer portal — is the
only consignment ticket left, and it waits on the customer portal (Effort 2/identity ticket 07).
