# ADR 0013 — The command lists are checked against `package.json`

**Status:** accepted (2026-09-29)
**Context:** Three documented failures in this repository are the same failure, and all
three were found by a person. `README.md` kept *an audit-log viewer* on its not-built
list for the twenty commits after `/admin/audit` shipped. `docs/renter-onboarding.md`
refused a partial refund in writing for two ADRs after a partial refund worked. The
counts in README drifted twice because they were quoted rather than run. A claim that a
document makes about the code is not type-checked, not served, and not rendered, so
every gate here is blind to it: a renamed script leaves `tsc` silent and `npm test`
green while the runbook tells a cashier to type a command that no longer exists.

Nothing in this ADR makes a document true. It checks the narrowest, most concrete slice
of the problem — a command either exists or it does not, and either some document names
it or none does — because that slice needs no judgement and costs a regex.

## Decisions

### 1. Two rules, one in each direction

- **Every script `package.json` defines is run by some document we own.** A command
  nobody wrote down is a command the next reader assumes is not there — which is how a
  deployment grows a by-hand step that was already a script.
- **Every command a document runs exists.** This is the one that fails at a counter:
  a runbook, a backup timer or an install sequence naming something that was renamed
  away.

Both come out of one pass over the same documents, so the second rule is nearly free
once the first exists. The pair is also what makes the report say *which* way the drift
went rather than "the docs are wrong".

### 2. "A document we own" is every markdown file outside a dot-directory

Rejected: holding the commands to `README.md` and `AGENTS.md` alone, the two files that
carry a command table. `npm run db:deploy` is documented in `docs/homelab-deploy.md` §7,
which is the file that owns deployment, and `npm run setup`'s restriction to
`localhost:5432` is explained there too. Demanding those commands in a second table
would create exactly the duplication `AGENTS.md` forbids — and a duplicated command list
is what drifts apart, which is why this ADR exists.

Every dot-directory is skipped, `node_modules` included. `/.agents/` is vendored skills
that describe *other* repositories; `npm run build` inside a skill about somebody else's
app is not a claim about this one, and a check that read it would fail for a reason no
one here can fix.

### 3. A mention, not a table row

A gate cannot judge prose. The correct home for a deployment command is the deployment
recipe's install sequence, not a table, so `npm run <x>` counts wherever it appears —
table cell, fenced block, or the middle of a sentence — because the alternative is a
checker that dictates the shape of the prose it is checking. The price is in *Known
gaps*: a command named once in passing satisfies the rule, and nothing distinguishes
that from a proper explanation.

### 4. Only two command shapes are read: `npm run <name>`, and `npm test`

`npm test` is npm's own shorthand for `npm run test`, and it is how `README.md` and
`AGENTS.md` spell the suite, so reading only the long form would report `test` as
undocumented against documents that run it on every line.

Nothing else after `npm` is a script reference: `npm install`, `npm ci` and `npm audit
fix` are not commands this file defines, and a pattern that took any word after `npm`
would produce a permanent phantom finding for each. A name ends at the first character
that cannot be in one — notably the full stop that ends a sentence — because no script
here contains a dot; a name that did would be a one-line change to that pattern, and a
comment says so.

### 5. It runs inside `npm run verify`

No build, no server, no database, so it is the cheapest gate in the set and belongs
beside `ui:audit` rather than in the job that has to build first. Being in `verify` is
what puts it in `verify:all` and in CI's first job — a gate that needs a build before it
can answer is a gate people run last, and by then the commit is made.

## Consequences

- `package.json` gains one script and one word in `verify`; the report prints
  `file:line` for a command that does not exist and just the name for a script no
  document runs, because the second has no site to point at.
- A new script cannot be committed without a document mentioning it — the failure lands
  in `npm run verify`, before the commit, rather than in review.
- The day it was written it found six commands the documents had never named: the two
  test slices, the watch loop, `db:migrate`, `db:studio` and `db:test:prepare`. They are
  now in `AGENTS.md`, which is where a maintainer looks.
- `AGENTS.md` obligation 1 said "No gate reads a document" and that stopped being true;
  it now says what this gate reads and what it still does not.
- No migration, no route, nothing an operator does differently. A shop that never edits
  a document is unaffected.

## Known gaps, stated rather than discovered

- **It reads no prose.** All three failures in the Context are untouched by it: a
  feature on the not-built list, a refusal described the wrong way round, a count quoted
  from memory. Those stay a person's job, and this ADR does not claim otherwise — it
  narrows what "no gate reads a document" meant rather than repealing it.
- **Markdown only.** A command written into `deploy/systemd/*.service`,
  `.github/workflows/verify.yml`, or a script's own output is not read. A unit that runs
  a renamed script still fails first at boot, and nothing here rehearses a boot.
- **A mention in a comment counts.** Nothing distinguishes "documented" from "named once
  in passing", and nothing checks that the sentence around the command is still true —
  `npm run backup` documented as taking a flag it no longer takes passes.
- **Aliases other than `npm test` are invisible.** `npm run-script x`, `pnpm`, `yarn`,
  and a direct `npx tsx scripts/…` are all unread; a script only ever invoked that way
  reads as undocumented and has to be named somewhere.
