/**
 * Every gate, in the order they depend on each other, as one command.
 *
 * The gates stay separate commands, and that is not an accident to be tidied away: a
 * failing unit test should report in two minutes rather than after a Next build, which
 * is exactly why CI splits them into two jobs. What this adds is the *release*
 * question asked once — is this commit green all the way through — without four
 * terminals and a note of where you got to.
 *
 * The order is a dependency order rather than a preference:
 *
 *   1. `verify` — types, the design-system audit, the colour ramp, the tests. Nothing
 *      is built or served, so it is the cheapest possible no.
 *   2. `acceptance` — the renter's journey from an empty schema. It *builds*, so it is
 *      also the only step that does.
 *   3. `route:audit` — every screen renders styled, against the build step 2 produced.
 *   4. `browser:target` — that build is still *parseable* by the phone a customer holds
 *      (ADR 0031). It reads the artefact rather than making one, which is why it sits
 *      here and not in `verify`: a chunk that no iOS 15 phone can parse renders a page
 *      with every button dead, and every other gate here reports it green.
 *   5. `limiter:race` — two servers, one database, one limit (ADR 0012).
 *   6. `offline:browser` — actual Chromium storage and cashier outage/replay journey.
 *
 * Steps 3–6 reuse step 2's build with `--skip-build`, deliberately. A release
 * check should be checking *one* artefact: rebuilding between gates would mean the
 * markup the audit walked is not the markup the journey sold through, and a build that
 * differs by nothing still costs a minute each time. `--skip-build` therefore means
 * "make no build at all" — step 2 reuses whatever is in `.next` too.
 *
 * Usage:
 *   npm run verify:all                 the whole sweep
 *   npm run verify:all -- --skip-build no build anywhere; reuse `.next`
 *   npm run verify:all -- --keep       leave each scratch schema behind to inspect
 */
import { shell } from './harness';

interface Step {
  /** What the step answers, for the summary. */
  label: string;
  /** The command, printed as well so a reader can re-run one step on its own. */
  command: string;
}

interface Result {
  label: string;
  seconds: number;
  ok: boolean;
}

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');
const keep = argv.includes('--keep');

/*
 * Refused rather than ignored. `acceptance` can be pointed at a server somebody else
 * started (`--base-url`), and that is a useful thing to do — but this sweep starts two
 * of its own, so forwarding the flag would check one deployment with step 2 and a
 * different one with step 3, and report the pair as a single verdict.
 */
if (argv.includes('--base-url')) {
  console.error(
    'verify:all starts its own servers, so `--base-url` has nothing to point at here.\n' +
      'To check a server that is already running, use: npm run acceptance -- --base-url <url>',
  );
  process.exit(1);
}

const keepFlag = keep ? ' --keep' : '';
const reuseBuild = ' --skip-build';

const steps: Step[] = [
  { label: 'verify (types, design-system audit, palette, tests)', command: 'npm run verify' },
  {
    label: 'acceptance (the renter journey, from an empty schema)',
    command: `npm run acceptance${skipBuild ? ' -- --skip-build' : ''}${keep ? ' -- --keep' : ''}`,
  },
  {
    label: 'route audit (every screen renders, and renders styled)',
    command: `npm run route:audit --${reuseBuild}${keepFlag}`,
  },
  {
    /*
     * No flags: it starts no server and makes no build, so there is nothing to reuse
     * and nothing to keep. It fails outright when `.next` is absent, which is the one
     * way running it out of order can be loud rather than quiet.
     */
    label: 'browser target (the build parses on the phone a customer holds)',
    command: 'npm run browser:target',
  },
  {
    label: 'limiter race (two servers, one database, one limit)',
    command: `npm run limiter:race --${reuseBuild}${keepFlag}`,
  },
  {
    label: 'offline browser (Chromium, IndexedDB, cash replay and drawer close)',
    command: `npm run offline:browser --${reuseBuild}${keepFlag}`,
  },
];

/** `1m 04s` rather than `64`, because a sweep is measured in minutes. */
function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

console.log('');
console.log('POS — every gate, in order');
console.log('==========================');
console.log(
  skipBuild
    ? '\n6 steps. No build: every step reuses the existing `.next`.'
    : '\n6 steps. The build is made once, by the journey, and the later gates reuse it.',
);

const results: Result[] = [];
const sweepStartedAt = Date.now();

for (const [index, step] of steps.entries()) {
  console.log(`\n── ${index + 1}/${steps.length}  ${step.label}`);
  console.log(`        $ ${step.command}`);

  const startedAt = Date.now();
  try {
    shell(step.label, step.command);
    results.push({ label: step.label, seconds: Math.round((Date.now() - startedAt) / 1000), ok: true });
  } catch {
    /*
     * Stopping here rather than pressing on: every later gate measures the same
     * commit, so a failure above makes their answers uninterpretable, and two of them
     * spend minutes starting servers to produce one.
     */
    results.push({ label: step.label, seconds: Math.round((Date.now() - startedAt) / 1000), ok: false });
    break;
  }
}

const total = Math.round((Date.now() - sweepStartedAt) / 1000);
const failed = results.filter((result) => !result.ok);

console.log('\nSummary');
console.log('-------');
for (const result of results) {
  console.log(`  ${result.ok ? '✓' : '✗'} ${result.label}  ·  ${formatDuration(result.seconds)}`);
}
for (const step of steps.slice(results.length)) {
  console.log(`  · ${step.label}  ·  not run`);
}

console.log(
  failed.length === 0
    ? `\nall ${results.length} gates passed in ${formatDuration(total)}`
    : `\n${failed.length} of ${steps.length} gates FAILED after ${formatDuration(total)} — the command that failed is printed under its heading above, and runs on its own`,
);

process.exit(failed.length === 0 ? 0 : 1);
