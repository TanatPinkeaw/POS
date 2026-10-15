# 09: The documents and the proof

**What to build:** Everything a later reader needs to not re-litigate this: the ADR, the
glossary, the product document, the operator's runbook, the wizard, and the acceptance
run that walks the new doors over real HTTP.

**Blocked by:** 01–08.
**Status:** done

- [ ] `docs/adr/0032-...md` — **status accepted**, **amends ADR 0030** (its *known
      limits* named LIFF and broadcast), with: LIFF as a door and not an identity; the
      npm SDK and why; `/line` as a public route; the three inbound-message decisions
      (recorded, deduped on LINE's own message id, no bytes for a non-text kind); the
      burst window and the group-cost arithmetic behind it; the second consent and why
      the first is not enough; multicast instead of `/broadcast`; quota as LINE's
      authority; at-most-once batches; admin-only sends. Each with the alternative it
      rejected, and a *Revisit when* section (rich menu, a reply composer if a shop asks
      for one, a per-shop LIFF id if the hosted build arrives).
- [ ] `CONTEXT.md` gains the words: **LIFF** (the in-LINE entry, a door not an identity),
      **promo consent** (the second consent and its two timestamps), **campaign**,
      **message log**, **burst window** — in the two existing tables, with the Thai the
      shop sees.
- [ ] `README.md`: *Not built yet* loses the LIFF and broadcast half of the LINE entry
      and keeps what is still true (rich menu, Flex/template editing, an in-app reply
      box); the LINE section gains the entry, the message log and the campaign screen;
      the route list and the counts that are quoted there are **re-measured**, not
      copied.
- [ ] `docs/renter-onboarding.md`: how a customer opens the shop inside LINE; how to
      write and send a campaign, with the allowance arithmetic in the operator's own
      words ("a group push costs one message per member; 300 a month on the free plan");
      what to do when a batch fails; where a customer's messages show up.
- [ ] `scripts/line-wizard.ts` reports the LIFF door (`LINE_LIFF_ID`) and the campaign
      door (`NOTIFY_LINE_TOKEN` + consent) in `--verify`, and every new env var is in
      `.env.example` with the warning it needs (`LINE_API_BASE_URL` moves where the
      channel token is sent).
- [ ] `npm run acceptance` gains its sections: the LIFF entry's sign-in path through the
      **existing** stub token endpoint (the entry posts the same body §20 already
      drives), and a campaign end to end against a stub LINE API base URL — quota read,
      multicast in batches, a 429 leaving a campaign `partial`, and a re-run sending
      nothing. Thai text is written by the Node script, never through `curl -d`.
- [ ] `ROUTE_WALK` carries `/line` and `/admin/line`; `npm run route:audit` passes.
- [ ] `npm run verify` and then `npm run verify:all` pass, and **`browser:target` still
      passes with `@line/liff` bundled**: the SDK is measured against the Safari 15.6
      floor like every other chunk, and if it carries syntax the floor cannot parse, the
      answer is a pinned older SDK version — never a weakened gate.
- [ ] The limitations are written down where they belong, in the ADR's own words:
      LINE's **image-message size and format limits are unverified** (so no number is
      asserted anywhere); the quota arithmetic is a courtesy and LINE's 429 is the
      authority. The one limitation this ticket recorded as *the handshake itself cannot be
      exercised here* got smaller after it landed: `npm run liff:door` (ADR 0032 §9) drives
      the entry, the phone step, the one-tap return, the refusal of a token minted for
      another channel and both failure sentences in a real browser, with LINE's SDK chunk
      replaced by a stand-in. **LINE's own app handoff** is what remains unmeasured, and
      that is the sentence the ADR keeps.

## Notes

The three documents that must **not** drift in this commit: `README.md` (what exists),
`docs/renter-onboarding.md` (what the person behind the counter does) and the ADR (why).
A claim that stops being true is deleted here, not left for the next round to discover —
that is the failure mode this repository has already paid for twice.
