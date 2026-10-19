# 03: The LINE screen says who it can reach today

**What to build:** a readiness panel on `/admin/line` — the five doors, the audience count, and
the outbox state.

**Blocked by:** 01.
**Status:** done

- [x] `readNoticeAudience()` in `src/lib/line-audience.ts`: bound, consented, reachable — two
      queries, members only, and deliberately **not** the campaign audience (which needs a
      different consent and would under-count by everyone who said yes to their order and no
      to marketing).
- [x] `oldestDueAt()` in `src/lib/notify-outbox.ts` — the timestamp that says *how long* a
      due row has waited, which `outboxHealth` alone cannot.
- [x] `LineReadinessPanel` (Card + Pill + a {@link InlineNotice} for the stall), one row per
      door with the sentence from the model. It renders even when nothing is configured —
      that is the case worth seeing, and the page's existing `lineConfigured` flag is a token
      check, not this question.
- [x] The audience gap is spelled out: "อีก N คนยินยอมแล้วแต่ยังไม่ได้เพิ่มเพื่อนร้าน",
      because that is the one cause a shop can act on at the counter.
- [x] Page reads `lineReadiness()` from `process.env`, `outboxHealth()`, `oldestDueAt()`, and
      computes the stall with the same `outboxStalled` the dashboard uses.

## Notes

The panel holds no rules. Every state, sentence and number comes from a module that is either
pure or a two-query read, so the screen cannot drift from the planner.
