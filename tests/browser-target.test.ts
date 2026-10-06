import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  auditBrowserslistConfig,
  auditSyntaxLevel,
  SAFARI_FLOOR,
  TARGET_CONFIG_FILE,
} from '@/lib/browser-target';

/**
 * The two halves of ADR 0031's gate, against samples and against this repository's
 * own tree.
 *
 * The samples are the point: the failure this prevents is a build that compiles, runs
 * every other gate green, renders a page, and is unreadable on the phone the shop's
 * customers actually carry. Each sample below is a shape that would ship that.
 */
describe('the browserslist floor', () => {
  it('accepts this repository’s own file', () => {
    const text = readFileSync(TARGET_CONFIG_FILE, 'utf8');
    expect(auditBrowserslistConfig(text)).toEqual([]);
  });

  it('reports a missing file as the original bug returning, not as an oversight', () => {
    expect(auditBrowserslistConfig(null)[0]).toMatchObject({ rule: 'target-config-missing' });
  });

  it('catches Next 16’s own default', () => {
    const findings = auditBrowserslistConfig(
      ['chrome 111', 'edge 111', 'firefox 111', 'safari 16.4'].join('\n'),
    );
    expect(findings.map((finding) => finding.rule)).toContain('safari-floor-drifted');
    expect(findings.map((finding) => finding.rule)).toContain('safari-floor-unpinned');
  });

  it('catches a tidy-up that keeps Safari but drops iOS, and the reverse', () => {
    expect(
      auditBrowserslistConfig(`safari ${SAFARI_FLOOR}`).map((finding) => finding.rule),
    ).toEqual(['safari-floor-unpinned']);
    expect(
      auditBrowserslistConfig(`ios_saf ${SAFARI_FLOOR}`).map((finding) => finding.rule),
    ).toEqual(['safari-floor-unpinned']);
  });

  it('accepts the floor itself and anything older', () => {
    expect(auditBrowserslistConfig(`safari ${SAFARI_FLOOR}\nios_saf 14.5`)).toEqual([]);
  });

  it('reads a version as numbers rather than as text, so 15.10 is above 15.6', () => {
    expect(auditBrowserslistConfig('safari 15.10\nios_saf 15.6')[0]).toMatchObject({
      rule: 'safari-floor-drifted',
    });
  });

  it('ignores comments and blank lines', () => {
    expect(auditBrowserslistConfig(`# safari 16.4 is what Next would pick\n\nsafari ${SAFARI_FLOOR}\nios_saf ${SAFARI_FLOOR}`)).toEqual([]);
  });
});

describe('the emitted syntax', () => {
  it('catches the class static block that shipped', () => {
    const code = 'class y extends i.default.Component{static{this.contextType=d.AppRouterContext}}';
    expect(auditSyntaxLevel(code)[0]).toMatchObject({ rule: 'static-block', line: 1 });
  });

  it('catches `#x in obj`, the other thing Safari 16.4 brought', () => {
    expect(auditSyntaxLevel('class A{#x=1;has(o){return #x in o}}')[0]).toMatchObject({
      rule: 'private-in',
    });
  });

  it('accepts what Safari 15.6 does parse, so the check does not cry wolf', () => {
    /* Class fields, private fields, `at`, `hasOwn` and top-level await all run there. */
    const code = [
      'class A { field = 1; #private = 2; static value = 3; get() { return this.#private; } }',
      'const last = [1, 2].at(-1);',
      'Object.hasOwn({}, "a");',
      'await Promise.resolve();',
    ].join('\n');
    expect(auditSyntaxLevel(code)).toEqual([]);
  });

  it('reports syntax the ES2022 grammar cannot express at all', () => {
    expect(auditSyntaxLevel('const re = /a/v;')[0]).toMatchObject({ rule: 'newer-than-es2022' });
  });

  it('parses a module as readily as a script, and reports a file that is neither', () => {
    expect(auditSyntaxLevel('export const one = 1;')).toEqual([]);
    expect(auditSyntaxLevel('function (').at(0)).toMatchObject({ rule: 'newer-than-es2022' });
  });

  it('points at the line the feature is on, not at the top of the file', () => {
    const code = ['const a = 1;', 'const b = 2;', 'class C { static { this.x = 1; } }'].join('\n');
    expect(auditSyntaxLevel(code)[0]).toMatchObject({ line: 3 });
  });

  it('stops listing after five, because a sixth location is noise', () => {
    /* Distinct names: the same class twice in one script is a redeclaration error, which
     * would have this test measuring the parser's refusal rather than the cap. */
    const code = Array.from(
      { length: 9 },
      (_, index) => `class C${index} { static { this.x = 1; } }`,
    ).join('\n');
    expect(auditSyntaxLevel(code)).toHaveLength(5);
  });
});
