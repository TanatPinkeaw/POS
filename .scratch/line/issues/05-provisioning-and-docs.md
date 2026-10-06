# 05 — Provisioning and the documents

**Blocking:** none. The human half of the feature.

**Built:**

- `scripts/line-wizard.ts` — the interactive walk for the steps only a human can
  do: create the Official Account, the Messaging API channel (token + secret),
  the LINE Login channel (id + secret), paste the callback and webhook URLs
  through the shop's tunnel, then `node scripts/line-wizard.ts --verify` reads
  `.env` and says which door each value opens. No new dependency; `readline`
  from the standard library, the shape `scripts/setup.ts` already uses.
- `.env.example` gains the five LINE values, commented with what each opens.
- `README.md` — the new row in *Beyond the spec*, the command row, the LINE
  section under configuration, and *Not built yet* reworded (the gap was
  "addresses"; what remains is LIFF/broadcast).
- `AGENTS.md` — *Where it stands* updated; open thread 3 rewritten to name what
  is now true (ADR 0030 built) and what is still open (LIFF, consent for
  broadcast).
- `docs/renter-onboarding.md` — the operator's section: what to create in
  LINE's console, what to paste where, why a customer must also add the shop as
  a friend, and what "ยกเลิกการผูก" does on the customer's own screen.
- `CONTEXT.md` — the vocabulary: subject/binding/consent/friend, and the rule
  that the code rides the customer's own LINE or nothing.

**Acceptance, met:** `npm run doc:audit` (every script a document runs exists;
every script a document should run is named); the wizard's `--verify` exits 0
on an unconfigured shop with "nothing configured" rather than a traceback.
