/**
 * `npm run doc:audit` — a document may not name a command that does not exist, and a
 * command may not exist that no document names.
 *
 * ADR 0013 is the decision; `src/lib/doc-audit.ts` is the detection and holds the
 * reasoning behind both rules. This file is only the part that cannot be unit-tested
 * that way: reading the tree and printing a report a person can act on.
 *
 * It runs inside `npm run verify` because it is the cheapest possible gate — no build,
 * no server, no database — and because the failure it prevents is invisible to every
 * other one.
 */
import {
  auditDocDrift,
  collectDocFiles,
  readDocs,
  readScripts,
  type DocFinding,
} from '../src/lib/doc-audit';

/** Where a missing command should go, said once rather than per finding. */
function guidance(kind: DocFinding['kind']): string {
  return kind === 'undocumented-script'
    ? '  It exists and nothing runs it. Document it where it belongs — README.md for\n' +
        '  anything a renter or an operator runs, AGENTS.md for the maintenance loop.'
    : '  A document runs it and package.json does not define it. Either add the script\n' +
        '  or delete the claim: a stale command is a runbook that fails at the counter.';
}

function main(): void {
  const scripts = readScripts();
  const files = collectDocFiles();
  const docs = readDocs(files);
  const findings = auditDocDrift(scripts, docs);

  if (findings.length === 0) {
    console.log(
      `doc audit: clean — ${scripts.length} scripts in package.json, every one of them ` +
        `run by one of ${files.length} markdown files, and no file runs a command that ` +
        'does not exist',
    );
    return;
  }

  console.error(`doc audit: ${findings.length} finding(s) — the command lists have drifted.`);
  console.error('');
  for (const finding of findings) {
    const where = finding.file ? `${finding.file}:${finding.line}: ` : '';
    console.error(`  ${where}${finding.kind}  ${finding.script}`);
  }
  console.error('');

  /* One explanation per kind, and only for the kinds that were found. */
  for (const kind of ['undocumented-script', 'phantom-command'] as const) {
    if (findings.some((finding) => finding.kind === kind)) {
      console.error(guidance(kind));
      console.error('');
    }
  }
  process.exit(1);
}

main();
