/**
 * The guard that keeps the command lists honest (ADR 0013).
 *
 * Two kinds of test, and the second is the one that matters: samples prove the
 * detector fires in both directions, and the last block runs it over this repository's
 * own documents, so `npm test` fails the moment a script ships unnamed or a document
 * keeps a command that was renamed away. A guard nobody runs is a comment.
 */
import { describe, expect, it } from 'vitest';

import {
  auditDocDrift,
  collectDocFiles,
  readDocs,
  readScripts,
  scriptReferences,
  type DocFile,
} from '@/lib/doc-audit';

/** One document, so a sample reads as a sentence rather than a structure. */
function doc(text: string, file = 'README.md'): DocFile[] {
  return [{ file, text }];
}

describe('the doc audit, undocumented scripts', () => {
  it('passes when every script is run somewhere', () => {
    const text = 'Install with `npm run setup`, then `npm test`.\n';

    expect(auditDocDrift(['setup', 'test'], doc(text))).toEqual([]);
  });

  it('reports a script no document runs, and has no line to point at', () => {
    const findings = auditDocDrift(['setup', 'backup'], doc('`npm run setup`\n'));

    expect(findings).toEqual([{ kind: 'undocumented-script', script: 'backup' }]);
  });

  it('counts a mention in any document, not only the command tables', () => {
    // ADR 0013 decision 1: `db:deploy` belongs in the deployment recipe, and demanding
    // it in README as well would be the duplication AGENTS.md forbids.
    const docs: DocFile[] = [
      { file: 'README.md', text: '`npm run setup`\n' },
      { file: 'docs/homelab-deploy.md', text: 'then `npm run db:deploy`\n' },
    ];

    expect(auditDocDrift(['setup', 'db:deploy'], docs)).toEqual([]);
  });
});

describe('the doc audit, phantom commands', () => {
  it('reports a command that does not exist, with the file and line', () => {
    const text =
      'Notes first.\n\nThe sweep is `npm run verify:all` — `npm run varify:all` is not a command.\n';

    expect(auditDocDrift(['verify:all'], doc(text))).toEqual([
      { kind: 'phantom-command', script: 'varify:all', file: 'README.md', line: 3 },
    ]);
  });

  it('does not mistake npm install, npm ci or npm audit for a script', () => {
    const text = 'npm install\nnpm ci\nnpm audit fix\nnpm test\n';

    expect(scriptReferences('README.md', text).map((reference) => reference.script)).toEqual([
      'test',
    ]);
    expect(auditDocDrift(['test'], doc(text))).toEqual([]);
  });

  it('reads a command in a fenced block, and stops before its flags', () => {
    const text = '```bash\nnpm run verify:all --skip-build --keep\n```\n';

    expect(scriptReferences('AGENTS.md', text)).toEqual([
      { file: 'AGENTS.md', script: 'verify:all', line: 2 },
    ]);
  });

  it('takes a full stop out of the name, because no script has one in it', () => {
    const text = 'A sweep — `npm run verify:all` — is npm run verify:all.\n';

    expect(scriptReferences('README.md', text).map((reference) => reference.script)).toEqual([
      'verify:all',
      'verify:all',
    ]);
  });

  it('reports both directions in one pass, undocumented first', () => {
    const findings = auditDocDrift(['setup', 'backup'], doc('`npm run setup`\n`npm run smoke`\n'));

    expect(findings).toEqual([
      { kind: 'undocumented-script', script: 'backup' },
      { kind: 'phantom-command', script: 'smoke', file: 'README.md', line: 2 },
    ]);
  });
});

describe('this repository', () => {
  /**
   * The whole guard, in one assertion: everything `package.json` defines is run by a
   * document, and no document runs something that is not defined.
   */
  it('has no undocumented script and no command that does not exist', () => {
    expect(auditDocDrift(readScripts(), readDocs(collectDocFiles()))).toEqual([]);
  });

  it('scans the whole tree, and neither node_modules nor the vendored skills', () => {
    const files = collectDocFiles();

    expect(files).toContain('README.md');
    expect(files).toContain('AGENTS.md');
    expect(files).toContain('docs/homelab-deploy.md');
    expect(files.length).toBeGreaterThan(15);
    expect(files.every((file) => file.endsWith('.md'))).toBe(true);
    expect(files.some((file) => file.startsWith('node_modules/') || file.startsWith('.'))).toBe(
      false,
    );
  });

  it('reads the scripts the way package.json lists them', () => {
    const scripts = readScripts();

    expect(scripts.length).toBeGreaterThan(25);
    // The ones the documents lean on hardest, so a rename can never pass unnoticed.
    expect(scripts).toEqual(expect.arrayContaining(['verify', 'verify:all', 'test', 'doc:audit']));
  });
});
