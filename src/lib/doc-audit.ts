/**
 * The guard that keeps the command lists honest — `npm run doc:audit`.
 *
 * This repository has two documented ways of going stale. A script ships and no
 * document mentions it, so the next reader assumes it is not there; or a command is
 * renamed and the runbook keeps telling someone to type the old name, at a counter,
 * at the moment they need it. Neither is caught by any other gate: a document is not
 * type-checked, and both failures leave every test green. The README kept *an
 * audit-log viewer* on its not-built list for twenty commits after the screen
 * shipped, and `docs/renter-onboarding.md` refused a partial refund in writing for
 * two ADRs after one worked — the same class of drift, with a person as the only
 * detector. This checks the half a machine can check.
 *
 * Two rules, one in each direction:
 *
 *   * **Every script in `package.json` is run by some document we own.** A command
 *     nobody wrote down is a command nobody will find.
 *   * **Every command a document runs exists.** A `npm run` that names nothing is a
 *     runbook that fails at the till.
 *
 * Three choices are deliberate and would otherwise be re-litigated:
 *
 *   * **Any document counts, not only the two command tables.** AGENTS.md tells the
 *     next round not to duplicate the documents, and `npm run db:deploy` belongs in
 *     the deployment recipe rather than in a second table — so requiring it in
 *     README *or* AGENTS.md would demand exactly the duplication the repository
 *     forbids, to satisfy a checker. A mention is a mention: this reads prose and
 *     fenced blocks alike.
 *   * **A mention, not a table row.** A gate cannot judge prose, and a command whose
 *     correct home is `docs/homelab-deploy.md` §7 must not be dragged into a table to
 *     pass. The price is stated under *gaps* in ADR 0013.
 *   * **`.agents/` is not ours to keep true.** Vendored skills describe other
 *     repositories — `npm run build` in a skill about somebody else's app is not a
 *     claim about this one — so every dot-directory, `node_modules` included, is
 *     skipped.
 *
 * The detection is pure and lives here so it can be unit-tested against samples *and*
 * against this repository's own documents; walking the tree and printing a report is
 * all `scripts/doc-audit.ts` does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface DocFile {
  /** Project-relative, with forward slashes. */
  file: string;
  text: string;
}

export interface ScriptReference {
  file: string;
  script: string;
  /** 1-based, so it matches the gutter in an editor. */
  line: number;
}

export type DocDriftKind = 'undocumented-script' | 'phantom-command';

export interface DocFinding {
  kind: DocDriftKind;
  script: string;
  /** Where the reference is. Absent for `undocumented-script`, which has no site. */
  file?: string;
  line?: number;
}

/**
 * `npm run <name>`, plus `npm test` — npm's own shorthand for `npm run test`.
 *
 * Two branches rather than one pattern over any word after `npm`, because `npm
 * install`, `npm ci` and `npm audit` are not script references and must not be
 * reported as commands that do not exist. A name stops at the first character that
 * cannot be in one — notably the dot in a name that ends a sentence — because no
 * script here contains a dot; if one ever does, this is the line to widen.
 */
const SCRIPT_REFERENCE = /\bnpm (?:run\s+([A-Za-z][\w:-]*)|(test)\b)/g;

/** 1-based line number of an offset, so a finding can be opened in an editor. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Every script a document runs, in the order it appears. */
export function scriptReferences(file: string, markdown: string): ScriptReference[] {
  return Array.from(markdown.matchAll(SCRIPT_REFERENCE), (match) => ({
    file,
    script: match[1] ?? match[2]!,
    line: lineAt(markdown, match.index ?? 0),
  }));
}

/**
 * Both rules over a set of documents. Undocumented scripts first, in the order
 * `package.json` lists them — that order groups related commands, so the report reads
 * as "this cluster is missing" rather than alphabet soup.
 */
export function auditDocDrift(scripts: readonly string[], docs: readonly DocFile[]): DocFinding[] {
  const known = new Set(scripts);
  const references = docs.flatMap((doc) => scriptReferences(doc.file, doc.text));
  const documented = new Set(references.map((reference) => reference.script));

  return [
    ...scripts
      .filter((script) => !documented.has(script))
      .map((script): DocFinding => ({ kind: 'undocumented-script', script })),
    ...references
      .filter((reference) => !known.has(reference.script))
      .map(
        (reference): DocFinding => ({
          kind: 'phantom-command',
          script: reference.script,
          file: reference.file,
          line: reference.line,
        }),
      ),
  ];
}

/**
 * The names `package.json` defines, in the order it defines them.
 *
 * Read as text rather than imported, so the audit sees the file the next reader sees:
 * an import would go through the loader (and, once, through a cache) and quietly
 * answer a different question.
 */
export function readScripts(packageJson = 'package.json'): string[] {
  const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return Object.keys(parsed.scripts ?? {});
}

/**
 * Every markdown file this repository owns, project-relative and sorted.
 *
 * `node_modules` and every dot-directory are skipped: the first is not ours, and the
 * second is where vendored skills (`/.agents/`) write about their own projects.
 */
export function collectDocFiles(root = '.'): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.md')) {
        found.push(relative(root, path).split(sep).join('/'));
      }
    }
  };

  walk(root);
  return found.sort();
}

export function readDocs(files: readonly string[]): DocFile[] {
  return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
}
