/**
 * The guard that keeps the retired theme retired (ADR 0003 §5).
 *
 * Two kinds of test here, and the second is the one that matters: samples prove
 * the detector fires, and the last block runs it over this repository's own `src/`
 * so that `npm test` fails the moment the vendored theme — or a Bootstrap class
 * name, or a `data-bs-*` attribute — comes back. A guard nobody runs is a comment.
 */
import { describe, expect, it } from 'vitest';

import {
  auditSource,
  auditTree,
  classNameValues,
  classTokens,
  collectSourceFiles,
  maskComments,
} from '@/lib/ui-audit';

const ANY = 'src/components/example.tsx';

function rules(source: string): string[] {
  return auditSource(ANY, source).map((finding) => finding.rule);
}

describe('the ui audit detector', () => {
  it('passes a screen that is on the design system', () => {
    const source = `
      import styles from './Thing.module.css';
      import { Button, Card } from '@/components/ds';

      export function Thing({ tone }: { tone: 'a' | 'b' }) {
        return (
          <Card className="ln-cut">
            <Button className={\`\${styles.button} ln-row\`}>ยืนยัน</Button>
            <span className={tone === 'a' ? 'ln-num' : styles.muted}>฿120</span>
          </Card>
        );
      }
    `;

    expect(auditSource(ANY, source)).toEqual([]);
  });

  it('catches a Bootstrap class in a plain className', () => {
    const findings = auditSource(ANY, '<div className="card-body text-muted">x</div>');

    expect(findings.map((finding) => finding.text)).toEqual(['card-body', 'text-muted']);
    expect(new Set(findings.map((finding) => finding.rule))).toEqual(new Set(['bootstrap-class']));
  });

  it('catches a Bootstrap class in a template literal next to a substitution', () => {
    // The value is a template literal, and the assertion is that the `${…}` does
    // not hide the class after it — the shape every migrated screen uses.
    const findings = auditSource(ANY, '<div className={`${styles.hero} btn btn-primary`}>x</div>');

    expect(findings.map((finding) => finding.text)).toEqual(['btn', 'btn-primary']);
  });

  it('catches a hardcoded class in a ternary, but not the comparison operand', () => {
    const findings = auditSource(
      ANY,
      "<div className={align === 'end' ? 'text-end' : styles.start}>x</div>",
    );

    // `'end'` is an operand of `===` and is not a class; `'text-end'` is.
    expect(findings.map((finding) => finding.text)).toEqual(['text-end']);
  });

  it('catches a data-bs-* attribute, in either spelling', () => {
    const findings = auditSource(
      ANY,
      '<button data-bs-toggle="dropdown" data-toggle="modal">x</button>',
    );

    expect(findings.map((finding) => finding.text)).toEqual(['data-bs-toggle', 'data-toggle']);
    expect(rules('<button data-bs-toggle="modal">x</button>')).toEqual(['bootstrap-attribute']);
  });

  it('catches a reference to the retired theme, in markup and in CSS', () => {
    expect(rules("const sheet = '/hope-ui/assets/css/custom.min.css';")).toEqual(['retired-theme']);
    expect(rules("import { Card } from '@/components/hope/ui';")).toEqual(['retired-theme']);
    expect(rules('.x { background: url(/hope-ui/assets/images/loader.gif); }')).toEqual([
      'retired-theme',
    ]);
  });

  it('ignores the vocabulary this codebase documents in comments', () => {
    // `Button` explains what `btn btn-primary` could not do; `Menu` explains what
    // `data-bs-toggle` cost. A guard that read comments would make writing that
    // down a build failure.
    const source = `
      /**
       * Two things it does that ad-hoc \`<button className="btn btn-primary">\`
       * markup cannot, unlike the vendored \`/hope-ui/\` theme's dropdown, which
       * is driven by \`data-bs-toggle\`.
       */
      export function Button() {
        // A leftover from <div className="card-body">, kept as a note.
        return <button className="ln-button">x</button>;
      }
    `;

    expect(auditSource(ANY, source)).toEqual([]);
  });

  it('reports a line and column that point at the token', () => {
    const lastLine = 'const el = <div className="btn">x</div>;';
    const source = `const a = 1;\nconst b = 2;\n${lastLine}\n`;

    // The column is 1-based and lands on the `b` of `btn`, so an editor can open
    // the report and be looking at the offending class.
    expect(auditSource(ANY, source)).toEqual([
      {
        file: ANY,
        line: 3,
        column: lastLine.indexOf('btn') + 1,
        rule: 'bootstrap-class',
        text: 'btn',
      },
    ]);
  });
});

describe('masking and extraction', () => {
  it('blanks comments without moving anything else', () => {
    const source = 'a// btn\nb/* card */c';
    const masked = maskComments(source);

    // Same length, same lines, and everything that is not a comment survives.
    expect(masked).toHaveLength(source.length);
    expect(masked.split('\n')).toHaveLength(2);
    expect(masked.replace(/ /g, '')).toBe('a\nbc');
  });

  it('does not mistake a comment marker inside a string for a comment', () => {
    expect(maskComments("const url = 'https://x/y';\n// gone")).toBe(
      "const url = 'https://x/y';\n       ",
    );
  });

  it('reads the class names out of a className expression', () => {
    const values = classNameValues('<div className={`${styles.a} ln-row`}>x</div>');

    expect(values.map((value) => value.value)).toEqual(['${styles.a} ln-row']);
    expect(classTokens(values[0]!.value)).toEqual([{ token: 'ln-row', index: 12 }]);
  });

  it('survives a nested template literal inside a substitution', () => {
    const values = classNameValues('<span className={`ln-pill ${styles[`pill_${tone}`]}`}>x</span>');

    expect(classTokens(values[0]!.value).map((token) => token.token)).toEqual(['ln-pill']);
  });
});

describe('this repository', () => {
  it('has no Bootstrap class, data-bs-* attribute or /hope-ui/ reference in src/', () => {
    expect(auditTree('src')).toEqual([]);
  });

  it('scans the whole tree, not a sample of it', () => {
    expect(collectSourceFiles('src').length).toBeGreaterThan(200);
    expect(collectSourceFiles('src').some((file) => file.endsWith('.css'))).toBe(true);
  });
});
