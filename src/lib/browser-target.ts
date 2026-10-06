/**
 * ADR 0031 — whether the JavaScript the shop ships can be *parsed* by the phone a
 * customer holds.
 *
 * The failure this exists for was invisible to every other gate. Next 16, with no
 * browserslist config, compiles for `chrome 111, edge 111, firefox 111, safari 16.4`
 * and hands that to Turbopack — and Safari 16.4 is the first version that parses a
 * class *static block*, which Next's own App Router client runtime contains. So the
 * emitted chunk threw a SyntaxError during parsing on a phone whose last update was
 * iOS 15: React never hydrated, the page kept its server HTML, and every control
 * that needs JavaScript was quietly dead. `npm run build` was green, the tests were
 * green, the page rendered, and only a real old phone showed the hole.
 *
 * Two questions are asked, and they are different questions:
 *
 *   1. Is the floor still where ADR 0031 put it? `.browserslistrc` is the only place
 *      the compiler reads it, and deleting the file silently restores Next's modern
 *      default — which is exactly how this shipped once.
 *   2. Did the emitted code honour that floor? A config can be present and still not
 *      applied, and a dependency can ship syntax nobody transpiles.
 *
 * **The grammar ceiling is ES2022, not ES2021, on purpose.**
 * Safari 15.6 implements class fields, private fields, top-level await, `Array.at`,
 * `Object.hasOwn` and the `d` regular-expression flag — all of them ES2022 or later on
 * paper. Refusing the whole ES2022 grammar would flag code that phone runs perfectly
 * well, and a check that cries wolf is worse than no check. What Safari 15.6 genuinely
 * cannot parse is narrower, and the two features are the ones that bit us:
 * a class static block and `#x in obj` (both Safari 16.4). So this parses at ES2022,
 * rejects anything the ES2022 grammar itself cannot express (the `v` flag on a
 * regular expression, `using` declarations), and walks the tree for those two
 * features by name.
 *
 * What it deliberately does **not** check: runtime APIs. `AbortSignal.timeout` and
 * `URL.canParse` are absent on that phone too, and no syntax tree can tell you a
 * property was called — that belongs to the phone test, and to ADR 0031's honest
 * half.
 *
 * Pure by construction — text in, findings out — so it is unit-tested against samples
 * and against this repository's own `.browserslistrc`. The walk over `.next` lives in
 * `scripts/browser-target.ts`.
 */
import { parse } from 'next/dist/compiled/acorn';

/** The oldest Safari ADR 0031 promises to work on. One place; the gate reads it. */
export const SAFARI_FLOOR = '15.6';

/** The file the compiler reads. Named here so the script and the message agree. */
export const TARGET_CONFIG_FILE = '.browserslistrc';

export interface TargetFinding {
  /** 1-based, so it reads like an editor's gutter. */
  line: number;
  column: number;
  /** What kind of problem, stable and greppable. */
  rule: string;
  /** The offending text, trimmed to what is worth reading. */
  text: string;
}

/* ------------------------------------------------------------- the config */

/** `15.6` and `[15, 6]`, compared numerically rather than as strings. */
function toParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

/** `a` is newer than `b`? Missing parts count as zero, so `15` equals `15.0`. */
function isNewer(a: string, b: string): boolean {
  const left = toParts(a);
  const right = toParts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference > 0;
    }
  }
  return false;
}

/** The pinned version on a browserslist line, or null when the line is not that pin. */
function pinnedFloor(line: string, browser: string): string | null {
  const match = new RegExp(`^${browser}\\s+(\\d+(?:\\.\\d+)*)`).exec(line);
  return match ? match[1] : null;
}

/**
 * Is the floor still where the ADR put it?
 *
 * `text` is the file's contents, or null when there is no file at all — a missing
 * `.browserslistrc` is not an oversight here, it is the original bug returning, so it
 * is reported as squarely as a drifted version.
 */
export function auditBrowserslistConfig(text: string | null): TargetFinding[] {
  if (text === null) {
    return [
      {
        line: 1,
        column: 1,
        rule: 'target-config-missing',
        text: `${TARGET_CONFIG_FILE} does not exist`,
      },
    ];
  }

  const findings: TargetFinding[] = [];
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();

  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (line.length === 0) {
      return;
    }
    for (const browser of ['safari', 'ios_saf'] as const) {
      const pinned = pinnedFloor(line, browser);
      if (pinned === null) {
        continue;
      }
      seen.add(browser);
      if (isNewer(pinned, SAFARI_FLOOR)) {
        findings.push({
          line: index + 1,
          column: raw.indexOf(browser) + 1,
          rule: 'safari-floor-drifted',
          text: `${line} — the floor is Safari ${SAFARI_FLOOR}`,
        });
      }
    }
  });

  /*
   * A missing `safari` or `ios_saf` line is not the same finding as a wrong one: the
   * first means the two browsers the decision is *about* are no longer pinned at all,
   * which is what a tidy-up that deletes "redundant" lines looks like.
   */
  for (const browser of ['safari', 'ios_saf'] as const) {
    if (!seen.has(browser)) {
      findings.push({
        line: 1,
        column: 1,
        rule: 'safari-floor-unpinned',
        text: `no \`${browser}\` line — nothing pins it to ${SAFARI_FLOOR}`,
      });
    }
  }

  return findings;
}

/* ------------------------------------------------------- the emitted code */

interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/** The two ES2022 features Safari 15.6 cannot parse, named with the version that can. */
const UNREADABLE_BY_TARGET: Record<string, string> = {
  StaticBlock: 'static-block',
  'private-in': 'private-in',
};

/** The rule for a node, or null when the target's Safari reads it fine. */
function ruleFor(node: Node): string | null {
  if (node.type === 'StaticBlock') {
    return UNREADABLE_BY_TARGET.StaticBlock;
  }
  if (
    node.type === 'BinaryExpression' &&
    node.operator === 'in' &&
    (node.left as Node | undefined)?.type === 'PrivateIdentifier'
  ) {
    return UNREADABLE_BY_TARGET['private-in'];
  }
  return null;
}

/** 1-based line and column of an offset, so a finding points at a place. */
function positionOf(code: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < code.length; index += 1) {
    if (code[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** Enough of the code to recognise it, and no more, because a chunk is minified. */
function snippetAt(code: string, start: number, end: number): string {
  const from = Math.max(0, start - 24);
  const to = Math.min(code.length, Math.max(end, start + 1) + 24);
  return (from > 0 ? '…' : '') + code.slice(from, to).replace(/\s+/g, ' ').trim() + (to < code.length ? '…' : '');
}

/**
 * Walk the tree for the two named features. An explicit stack rather than recursion:
 * a bundle is deep, and a stack overflow would read as "this file is fine".
 */
function findUnreadableFeatures(tree: Node, code: string): TargetFinding[] {
  const findings: TargetFinding[] = [];
  const stack: Node[] = [tree];

  while (stack.length > 0) {
    const node = stack.pop() as Node;
    const rule = ruleFor(node);
    if (rule !== null) {
      const { line, column } = positionOf(code, node.start);
      findings.push({ line, column, rule, text: snippetAt(code, node.start, node.end) });
      /* Capped: past the first few the message stops being a location and becomes noise. */
      if (findings.length >= 5) {
        return findings;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && typeof (item as Node).type === 'string') {
            stack.push(item as Node);
          }
        }
      } else if (value && typeof value === 'object' && typeof (value as Node).type === 'string') {
        stack.push(value as Node);
      }
    }
  }

  return findings;
}

/**
 * Can the target's Safari parse this file at all?
 *
 * Parsed as a classic script first and as a module second: they differ in ways that
 * have nothing to do with the question (a module is strict, a script is not), and a
 * file that parses either way is a file the phone can read. Only when *both* refuse is
 * it reported, with the script error, whose offset is where the reader should look.
 */
export function auditSyntaxLevel(code: string): TargetFinding[] {
  let tree: Node | null = null;
  let failure: string | null = null;

  for (const sourceType of ['script', 'module'] as const) {
    try {
      tree = parse(code, { ecmaVersion: 2022, sourceType, allowHashBang: true }) as unknown as Node;
      break;
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
  }

  if (tree === null) {
    return [
      {
        line: 1,
        column: 1,
        rule: 'newer-than-es2022',
        text: failure ?? 'the parser refused this file',
      },
    ];
  }

  return findUnreadableFeatures(tree, code);
}
