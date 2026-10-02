# 06: Getting the receipt — a portal download and a signed link

**What to build:** A customer downloads the last month's receipts; a walk-in with no account
gets one through a signed link.

**Blocked by:** 05.
**Status:** ready-for-agent

- [ ] A signed link that names exactly one order and expires — the shape of
      `pickup-token.ts`, with its own audience so another session cannot present it.
- [ ] The **last month** is the access window: an older bill offers no file while its order
      stays visible. Nothing is ever deleted.
- [ ] The link can be handed over at the counter for a customer who never registered.
- [ ] Reissue rather than reuse: a spent or expired link does not silently keep working.
- [ ] Tests: a link serves exactly its order and expires; a bill older than a month offers no
      file but still lists; a link for another order is refused; the order data is untouched by
      any download.

## Notes

"One month" is an access rule, not a retention rule (ADR 0021 §2). Deleting a tax document
would break the retention and the gapless series at once.
