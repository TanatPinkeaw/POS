# Code review — offline till completion

**Fixed point:** `385a490` ("Give the till its own store, and give a shop a reserve it
may not sell through"). Scope is the **uncommitted working tree** against it: 44
tracked files (`+1812 / −371`) plus 19 new files (`src/lib/offline-sales.ts`,
`sale-instant.ts`, `prisma-errors.ts`, `src/app/api/v1/pos/sync/route.ts`,
`NumberLoanRecovery.tsx`, `scripts/offline-browser.ts`, two migrations, two test
suites, `docs/agents/*`, `.scratch/*`).

**Spec sources:** `.scratch/offline-till-completion/spec.md` (approved scope),
`docs/offline-till-spec.md`, `docs/adr/0019-the-till-sells-offline.md`.
**Standards sources:** `AGENTS.md` (repo rules: pure vs persistence, `withApi` +
signed role auth, DS-only UI, Thai copy / English identifiers, one new dev-only dep,
repository-as-memory commentary) plus the Fowler smell baseline.

The two axes were run separately and are reported separately; they are not merged or
reranked. (No sub-agent tool is available in this session, so both passes were done
in one context but kept in separate sections.)

---

## Standards

### Documented-standard breaches (hard)

1. **Bare `id: 1` instead of `SHOP_ROW_ID`** — `src/lib/offline-sales.ts`, in
   `recordBill`:
   ```ts
   discount > Number((await tx.shops.findUniqueOrThrow({ where: { id: 1 } })).supervisor_discount_limit_thb)
   ```
   `src/lib/shop.ts` exports `SHOP_ROW_ID`, and `number-blocks.ts`, `cash-shifts.ts`
   and `shop.ts` itself all use the constant. The literal re-introduces the magic
   singleton id the constant exists to eliminate. **Fix:** import and use
   `SHOP_ROW_ID`; better still, read the limit off the `settings` row that
   `loadVatSettings`/`lockShopRow` already touched.

2. **Commentary regression in `src/lib/offline-db.ts`.** The rewrite roughly halved
   the file, and it did so by deleting the explanatory header and the rationale for
   the memory fallback, the version/no-migration decision, and the Web-Lock
   lifecycle — replacing them with one-line comments. `AGENTS.md` rule 1 ("the
   repository is the memory… a claim that stops being true is documented") and the
   surrounding `src/lib/*` files (which carry long rationale headers) make this a
   standard, not a taste. The new `createDeviceStorage` now **throws** on a failed
   read/write and flips `persists` to false with no note explaining that the memory
   fallback was deliberately abandoned — a later reader will "fix" it back.
   **Fix:** restore the header comments the surrounding modules' convention expects
   (the terse code itself is fine).

### Baseline smells (judgement calls)

3. **Duplicated Code — the block-ownership guard.** The same "this loan is not mine"
   check appears three times, near-verbatim:
   - `offline-sales.ts` `recordBill` → `DEVICE_NUMBER_WRONG_OWNER`
   - `offline-sales.ts` `applyReport` → `REPLAY_WRONG_CASHIER`
   - `orders.ts` `createPosSale` → `DEVICE_NUMBER_WRONG_OWNER`

   The SQL, the Thai message and the code string are copy-pasted. **Fix:** one
   `assertNumberLoanOwned(db, blockId, userId)` beside `number-blocks.ts`.

4. **Duplicated Code — the queue-counter seed subquery.** This expression is written
   out twice, character-for-character, in `number-blocks.ts` (`openNumberBlock`) and
   `shop.ts` (`allocateQueueNumber`):
   ```sql
   GREATEST(
     COALESCE((SELECT MAX(queue_number) FROM orders WHERE queue_day = ${day}::date), 0),
     COALESCE((SELECT MAX(last_used_number) FROM number_blocks WHERE series = 'queue' AND day = ${day}::date AND reported_at IS NOT NULL), 0)
   )
   ```
   It is the load-bearing expression for "survive reserving tomorrow before today
   ends", and it now has two homes that can drift. **Fix:** one shared SQL fragment
   or one helper both callers pass `day` to.

5. **Feature Envy / fragile guard in `assertSameBill`.** The "is this really the same
   bill?" comparison reaches into the **`audit_logs.detail` JSON blob** (rather than
   columns) for `soldAtFromDevice`, `soldDayFromDevice` and `printedNumbers`:
   ```ts
   const audit = await db.audit_logs.findFirst({ where: { target_id: id, action: 'offline_sale_synced' }, select: { detail: true } });
   ...
   if ((detail?.soldAtFromDevice && ...) || (detail?.soldDayFromDevice && ...) || (detail?.printedNumbers && ...) || ...)
   ```
   Every one of those guards is **skipped when the audit row is absent** (`detail`
   null/undefined), so the strictness of the idempotency check silently depends on
   the trail being present. The audit log is the wrong home for identity data a
   correctness guard reads. **Fix:** persist the device identity (in particular the
   printed-number values) on the order or a dedicated row, and compare against that;
   keep the audit row for humans.

6. **Divergent Change / Long Function — `recordBill`.** ~230 lines inside a single
   `prisma.$transaction`: identity reconciliation, clock/day handling, pricing,
   four separate malformed-bill checks, tax-settings drift, ownership, number
   claiming, order creation, stock settlement, payment leg, price-disagreement
   detection, and the audit row. It is cohesive, but it is the one function a later
   reader must hold entire to change any part of a replayed bill. **Judgement call:**
   extracting the validation block and the settle/audit block would not weaken the
   transaction.

7. **Mysterious Name — `computeInvoicesDue`.** It returns a `boolean` (`isVatInvoice`)
   yet its name reads as a count of documents due. `invoicesDue !== bill.tax.isVatInvoice`
   is harder to read than it needs to be. **Fix:** `wouldIssueVatInvoice(...)` or
   `issuesVatInvoice(...)`.

8. **Data Clumps — the bill shape lives in three places.** `QueuedBill`
   (`sync-plan.ts`, client), `OfflineBillRequest` (`offline-sales.ts`, server) and
   `offlineBillSchema` (`schemas.ts`, wire) are three parallel definitions of one
   bill, and the first two are ~90% identical. A client/server boundary justifies
   *two*, not three-with-a-third-schema. **Judgement call:** the wire schema is
   necessary; consider deriving the server type from the schema (`z.infer`) so the
   shape is stated once per side.

### Not flagged
- No tooling-enforced issues (typecheck, `ui:audit`, `route:audit` all pass; the
  `ln-flex`/`ln-gap-2` undefined-class violations this review followed up are now
  fixed to the real `ln-row` utility).
- No new runtime dependency; Playwright is dev-only and approved.

---

## Spec

Requirements taken from the completion spec's approved scope and from the numbered
user stories in `docs/offline-till-spec.md`.

### (a) Requirements missing or partial

- **None outstanding against the approved scope.** Explicit preparation, durable
  bills before confirmation, exclusive writer, today/tomorrow loans, idempotent
  sequential replay, local catalogue search/scan + queue, reconnect/manual send, and
  send-all-then-release-before-close are each implemented and covered. The two
  honest gaps the spec itself names — no field pilot, no observed CI run — are
  stated in the docs rather than hidden.

### (b) Behaviour not asked for (scope creep)

- **`scripts/notify-worker.ts`** changes the forced `process.exit` to `process.exitCode`
  plus `await prisma.$disconnect()`. It is a real Windows/libuv crash fix and it is
  what makes `acceptance` green, but it is **outside the offline spec** and belongs
  to its own change (or an explicit note in the PR). Not wrong — just untracked by
  the spec.
- **`docs/agents/{issue-tracker,domain,triage-labels}.md`** are skill scaffolding
  newly added under the spec's umbrella. Harmless, but not spec content.
- **`src/app/(admin)/admin/dashboard/page.tsx` loan-recovery card** is asked for
  (user story 28 / "dashboard gains the reservation task"), so it is in scope; the
  *stock-shortage* card is likewise asked for (story 26).

### (c) Requirements that look implemented but where the implementation looks wrong

1. **The same-bill guard reads its identity out of the audit trail** (see Standards
   #5). ~~Correctness gap~~ **Withdrawn on investigation — the case is unreachable.**
   `client_ref` is written in exactly one place (`offline-sales.ts`, line 351) inside
   the same transaction as the `offline_sale_synced` audit row, and `audit_logs` carries
   a `BEFORE UPDATE OR DELETE` trigger (`20260104000000_supervisor_pin_and_audit`) that
   raises `restrict_violation`. So an order with a non-null `client_ref` always has its
   identity row, and `detail` is never absent. The risk the review first named — a
   reused reference silently accepted as a `duplicate` — cannot occur. It remains a
   plain coupling smell (identity a correctness check needs, stored in a table kept for
   humans), now hardened against future refactors (see Resolution).

2. **`REPLAY_BILL_MALFORMED` conflated two distinct refusals.** The check
   `bill.receivedThb < finalAmount || discount > limit` raised one code and one
   message for both "cash tendered is short" and "discount past the shop's limit".
   The spec asks for typed refusals a screen can act on; two causes behind one code
   loses that. **Fixed:** split into `REPLAY_CASH_SHORT` / `REPLAY_DISCOUNT_OVER_LIMIT`
   with a covering test.

3. **`soldDay` disagreement is warn-only.** The spec keeps `soldDay` "so a
   disagreement is visible", and the implementation warns — this matches the spec,
   so not a bug; recording it only because it is the kind of thing a later reader
   might expect to be a refusal.

4. **Accepted and correct, worth stating:** `applyReport` refuses a report that
   counts past the bills actually received, and `syncOfflineBatch` marks **all**
   reports refused when any bill was refused (`REPLAY_PENDING`). That is stricter
   than "unclosed loans remain recoverable" alone and is the safe direction the spec
   argues for ("the only safe partial outcome is *frozen*").

### Cross-check: the prepared-online path
The old plan expected online prepared sales to re-validate price on the server;
the shipped behaviour queues them through the device store and replays them as the
same identity. `docs/offline-till-spec.md` was updated to describe exactly this
("the hook rechecks active stock and prices; a changed price requires cashier
reconfirmation") and the browser journey asserts it. **Spec and code agree** — no
finding, noted so a reviewer does not re-open it.

---

## Summary

- **Standards:** 8 findings — 2 hard (bare `SHOP_ROW_ID` literal; `offline-db.ts`
  commentary regression), 6 judgement calls. Worst: the `SHOP_ROW_ID` literal
  (trivial) and the duplicated queue-counter subquery (two homes for the load-bearing
  expression).
- **Spec:** 2 findings, both implementation-correctness: the same-bill guard reading
  identity from the audit log (weakens "incompatible identity reuse refused"), and
  `REPLAY_BILL_MALFORMED` merging two refusal causes. One scope-creep note
  (`notify-worker.ts`) and one honest-gap note (CI unobserved), both already
  documented.

**Verdict per axis.** Standards: passes with cleanups — nothing blocks release, the
two hard items are small and local. Spec: passes the approved scope; the same-bill
identity guard is the one item worth fixing before a shop runs it, because it is the
double-charge/double-record guard and its strength currently depends on an unrelated
table.

No Git operation was performed; the working tree remains uncommitted.

---

## Resolution (this session)

| Finding | Axis | Status |
| --- | --- | --- |
| Standards #1 bare `id: 1` | Standards | Fixed → `SHOP_ROW_ID` |
| Standards #2 `offline-db.ts` commentary | Standards | Fixed → rationale restored |
| Standards #3 duplicated ownership guard | Standards | Fixed → `assertNumberBlocksOwnedBy` in `number-blocks.ts`, used by `offline-sales.ts` and `orders.ts` |
| Standards #4 duplicated queue-counter seed | Standards | Fixed → `queueCounterSeed(day)` in `shop.ts`, used by both callers |
| Standards #5 audit-log identity in `assertSameBill` | Standards | Hardened → fails closed on a missing identity record (defence in depth) |
| Standards #6 `recordBill` long function | Standards | Left as a judgement call (transaction cohesion) |
| Standards #7 `computeInvoicesDue` name | Standards | Fixed → `issuesVatInvoice` |
| Standards #8 three-phase bill shape | Standards | Left (client/server boundary justifies two; wire schema necessary) |
| Spec #1 same-bill guard | Spec | Withdrawn (unreachable) + hardened |
| Spec #2 merged `REPLAY_BILL_MALFORMED` | Spec | Fixed → two codes + test |
| Spec scope creep `notify-worker.ts` | Spec | Left, documented |

Verified after the changes: `npm run verify:all` — **all 5 gates passed in 4m 08s**
(`verify` 61 files / **920 tests**, `acceptance` 140, `route:audit` 23/23, `limiter:race`,
`offline:browser` 21 checks). The fail-closed branch in `assertSameBill` has no test: the
append-only trigger is exactly what makes its trigger case unreachable, and there is no
public seam to force a missing identity row. That is stated here rather than papered over.
