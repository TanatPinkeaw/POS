/**
 * `npm run browser:target` — every file the build emitted has to parse on the phone
 * a customer is holding (ADR 0031).
 *
 * The detection is in `src/lib/browser-target.ts`, where it is unit-tested against
 * samples and against this repository's own `.browserslistrc`. This file is only the
 * part that cannot be tested that way: walking `.next` and printing a report a person
 * can act on — the same split `ui:audit` and `doc:audit` use.
 *
 * It reads a build rather than making one, which is why it belongs *after* the single
 * build `verify:all` makes: rebuilding here would check an artefact the other gates
 * never saw. Run it on its own after `npm run build`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  auditBrowserslistConfig,
  auditSyntaxLevel,
  SAFARI_FLOOR,
  TARGET_CONFIG_FILE,
  type TargetFinding,
} from '../src/lib/browser-target';

/** Where Turbopack puts everything the browser downloads. */
const BUILD_DIR = join('.next', 'static');

/**
 * Every `.js` the browser can be handed, at any depth.
 *
 * `.next/static` rather than `.next/static/chunks` alone: the failure is "this file
 * cannot be parsed", and a file this check does not open is a file it cannot promise
 * anything about.
 */
function collectScripts(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      collectScripts(path, found);
    } else if (entry.endsWith('.js')) {
      found.push(path);
    }
  }
  return found;
}

function print(findings: TargetFinding[]): void {
  console.error(`browser target: ${findings.length} finding(s) — the build is out of reach of the target phone.`);
  console.error('');
  for (const finding of findings) {
    console.error(`  ${finding.rule}  ${finding.line}:${finding.column}  "${finding.text}"`);
  }
  console.error('');
}

function main(): void {
  const configPath = join(process.cwd(), TARGET_CONFIG_FILE);
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null;

  const findings = auditBrowserslistConfig(configText).map((finding) => ({
    ...finding,
    rule: `${TARGET_CONFIG_FILE}: ${finding.rule}`,
  }));

  /*
   * The config findings are reported before the build is touched, and they stop the
   * run: with no pin, every later line would be describing Next's default rather than
   * this decision, and the useful fix is the file, not the chunks.
   */
  if (findings.length > 0) {
    print(findings);
    console.error(`  ${TARGET_CONFIG_FILE} is the one place the compiler reads the floor from —`);
    console.error(`  with it gone or drifted, Next 16 builds for safari 16.4 again.`);
    process.exit(1);
  }

  if (!existsSync(BUILD_DIR)) {
    console.error(
      `browser target: nothing to check — ${BUILD_DIR} does not exist.\n` +
        '  This gate reads a build rather than making one; run `npm run build` first.',
    );
    process.exit(1);
  }

  const scripts = collectScripts(BUILD_DIR);
  const found: string[] = [];

  for (const script of scripts) {
    for (const finding of auditSyntaxLevel(readFileSync(script, 'utf8'))) {
      found.push(`${script}:${finding.line}:${finding.column}  ${finding.rule}  "${finding.text}"`);
    }
  }

  if (found.length === 0) {
    console.log(
      `browser target: clean — ${scripts.length} files under ${BUILD_DIR} parse at the pinned ` +
        `floor (Safari ${SAFARI_FLOOR} / iOS ${SAFARI_FLOOR}), so a phone that stopped at ` +
        'iOS 15 can run the page rather than only render it',
    );
    return;
  }

  console.error(`browser target: ${found.length} finding(s) — the build is out of reach of the target phone.`);
  console.error('');
  for (const line of found.slice(0, 20)) {
    console.error(`  ${line}`);
  }
  if (found.length > 20) {
    console.error(`  … and ${found.length - 20} more`);
  }
  console.error('');
  console.error('  A class static block or `#x in obj` needs Safari 16.4, and that is the phone');
  console.error('  this shop cannot hand a dead page to. Check that .browserslistrc is still the');
  console.error('  file the build reads, and that nothing arrived pre-built.');
  process.exit(1);
}

main();
