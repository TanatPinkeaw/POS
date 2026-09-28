/**
 * The guard that keeps the retired theme retired — `npm run ui:audit`.
 *
 * ADR 0003 decision 5: the vendored Hope UI theme could only be deleted once, and
 * what makes the deletion stick is a check that fails the moment a Bootstrap class
 * name, a `data-bs-*` attribute or a `/hope-ui/` reference reappears in `src/`.
 * Without it the removal is a hope rather than an event — the markup still
 * compiles, and the screen that regressed just quietly renders unstyled, which is
 * exactly what the migration's own scaffolding comment warned about.
 *
 * Two properties are worth more here than cleverness:
 *
 *   * **Comments do not count.** This codebase documents the vocabulary it
 *     replaced: `Button` explains what `btn btn-primary` could not do, `Menu`
 *     explains what `data-bs-toggle` cost, `ds/index.ts` names the module it
 *     replaced. A check that read comments would make that documentation illegal.
 *     Comments are blanked — not removed — before scanning, so line and column
 *     numbers still point at the real file.
 *   * **The rule is stated positively.** Rather than a denylist of Bootstrap class
 *     names, which goes stale the first time Bootstrap adds one, every class in a
 *     literal `className` must be a project token (`ln-*`). Everything else comes
 *     from a CSS module. So a literal that is not `ln-*` is either the old
 *     vocabulary or a new hardcoded one, and both are worth failing over.
 *
 * The detection is pure and lives here so it can be unit-tested against samples
 * *and* against this repository's own tree; `scripts/ui-audit.ts` is only the part
 * that cannot be — walking the filesystem and printing a report.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type AuditRule = 'bootstrap-class' | 'bootstrap-attribute' | 'retired-theme';

export interface Finding {
  file: string;
  /** 1-based, so it matches the gutter in an editor. */
  line: number;
  column: number;
  rule: AuditRule;
  /** The offending text, quoted in the report. */
  text: string;
}

/** The only class prefix a literal `className` may use. */
const PROJECT_CLASS = /^ln-[a-z0-9-]+$/;

/**
 * Classes the design system uses that are deliberately not `ln-*`.
 *
 * Exactly one, and it is not a Bootstrap leftover: `dark` is the class the root
 * layout puts on `<body>` from the theme cookie, and `tokens.css` keys its entire
 * dark block off `body.dark`. Renaming it would be a token-layer decision rather
 * than a migration one, so it is named here instead of tolerated silently.
 */
const PROJECT_CLASSES: readonly string[] = ['dark'];

function isProjectClass(token: string): boolean {
  return PROJECT_CLASS.test(token) || PROJECT_CLASSES.includes(token);
}

/*
 * The retired theme's path, assembled from pieces rather than written out. This
 * file forbids these strings, and a detector whose own source contained them
 * verbatim would have to exempt itself from its own rule — which is how a guard
 * ends up with a hole in it.
 */
const HOPE = 'hope';
const RETIRED_THEME = new RegExp(`/${HOPE}-ui\\b|components/${HOPE}\\b`, 'g');

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css'] as const;

/**
 * Blank out comments, preserving every offset.
 *
 * A character-for-character replacement (spaces, with newlines left alone) rather
 * than a strip: findings carry line and column numbers, and the cheapest way to
 * keep them honest is never to shift the text being reported on.
 *
 * A comment marker inside a string is not a comment, so the scanner tracks the
 * three quoting styles. A template literal is treated as opaque text, which is
 * correct for class names — `${styles.x}` lives *inside* the value being read, not
 * in code — and wrong only for a `//` inside a `${…}` substitution, a shape this
 * codebase does not use.
 */
export function maskComments(source: string): string {
  const out = source.split('');
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (char === '/' && next === '*') {
        state = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (char === "'") {
        state = 'single';
      } else if (char === '"') {
        state = 'double';
      } else if (char === '`') {
        state = 'template';
      }
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        i += 1;
        continue;
      }
      out[i] = ' ';
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        state = 'code';
        i += 2;
        continue;
      }
      // Newlines survive, or every finding after a block comment would be
      // reported at the wrong line.
      if (char !== '\n') {
        out[i] = ' ';
      }
      i += 1;
      continue;
    }

    // Inside a string or template: only the closing quote matters.
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      state = 'code';
    }
    i += 1;
  }

  return out.join('');
}

/**
 * Length of the quoted literal starting at `start`, including both quotes.
 *
 * A template literal needs its own scanner rather than "read until the next
 * backtick": `` `ln-pill ${styles[`pill_${tone}`]}` `` ends at the *inner*
 * backtick under that rule, and the leftover text then looks like class names.
 * `${ … }` is therefore tracked by depth, with nested literals skipped whole.
 */
function literalLength(source: string, start: number): number {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return 0;
  }

  let i = start + 1;

  if (quote !== '`') {
    while (i < source.length && source[i] !== quote) {
      i += source[i] === '\\' ? 2 : 1;
    }
    return Math.min(i + 1, source.length) - start;
  }

  let substitution = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      i += 2;
      continue;
    }
    if (char === '$' && source[i + 1] === '{') {
      substitution += 1;
      i += 2;
      continue;
    }
    if (substitution > 0) {
      if (char === '}') {
        substitution -= 1;
        i += 1;
        continue;
      }
      if (char === '`' || char === "'" || char === '"') {
        i += literalLength(source, i);
        continue;
      }
      i += 1;
      continue;
    }
    if (char === '`') {
      return i + 1 - start;
    }
    i += 1;
  }

  return source.length - start;
}

/**
 * Blanks every `${ … }` substitution in a template's contents, preserving length.
 *
 * Blanked rather than removed so the offsets of the class names around it stay
 * aligned with the file — which is what makes the report point at the token.
 */
function blankSubstitutions(value: string): string {
  const out = value.split('');
  let i = 0;

  while (i < value.length) {
    if (value[i] !== '$' || value[i + 1] !== '{') {
      i += 1;
      continue;
    }

    let depth = 0;
    let j = i;
    while (j < value.length) {
      const char = value[j];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      } else if (char === '`' || char === "'" || char === '"') {
        j += literalLength(value, j);
        continue;
      }
      j += 1;
    }

    for (let k = i; k < j; k += 1) {
      if (out[k] !== '\n') {
        out[k] = ' ';
      }
    }
    i = j;
  }

  return out.join('');
}

interface ClassToken {
  token: string;
  /** Absolute offset in the scanned source, so the report points at the token. */
  index: number;
}

/**
 * The class tokens inside one `className` literal.
 *
 * A template substitution is blanked rather than dropped, so the offsets of the
 * tokens around it stay aligned with the file.
 */
export function classTokens(value: string, offset = 0): ClassToken[] {
  const stripped = blankSubstitutions(value);
  const tokens: ClassToken[] = [];

  for (const match of stripped.matchAll(/\S+/g)) {
    tokens.push({ token: match[0], index: offset + (match.index ?? 0) });
  }

  return tokens;
}

/**
 * True when the literal at `index` is an operand of a comparison rather than a
 * class name.
 *
 * Inside a `className` expression the two are spelled identically, and there is
 * no parser here to tell them apart: `column.align === 'end' ? styles.alignEnd :
 * undefined` contains a string that is never a class, while `theme === 'dark' ?
 * 'dark' : undefined` contains one that is. Position is what separates them — the
 * operand sits against a comparison operator, the class does not — so the
 * operator is what this looks for.
 */
function isComparisonOperand(source: string, index: number): boolean {
  const before = source.slice(0, index).trimEnd();
  const after = source.slice(index + literalLength(source, index)).trimStart();
  return /(===|!==|==|!=|<=|>=)$/.test(before) || /^(===|!==|==|!=|<=|>=)/.test(after);
}

/** Every `className` literal in a file, with the offset of its contents. */
export function classNameValues(source: string): { value: string; index: number }[] {
  const values: { value: string; index: number }[] = [];

  for (const match of source.matchAll(/\bclassName\s*=\s*/g)) {
    const start = (match.index ?? 0) + match[0].length;

    if (source[start] === '{') {
      /*
       * The value is an expression — `` className={`${styles.card} ln-row`} `` or
       * `className={tone === 'danger' ? 'ln-danger' : ''}` — so the class names
       * are the string literals inside it, not the expression itself.
       */
      const end = matchingBrace(source, start);
      for (let i = start + 1; i < end; i += 1) {
        const length = literalLength(source, i);
        if (length === 0) {
          continue;
        }
        if (!isComparisonOperand(source, i)) {
          values.push({ value: source.slice(i + 1, i + length - 1), index: i + 1 });
        }
        i += length - 1;
      }
      continue;
    }

    const length = literalLength(source, start);
    if (length > 0) {
      values.push({ value: source.slice(start + 1, start + length - 1), index: start + 1 });
    }
  }

  return values;
}

/** The index of the `}` matching the `{` at `start`, skipping quoted strings. */
export function matchingBrace(source: string, start: number): number {
  let depth = 0;
  let i = start;

  while (i < source.length) {
    const char = source[i];
    if (char === "'" || char === '"' || char === '`') {
      // A brace inside a string is not a brace.
      i += literalLength(source, i);
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    i += 1;
  }

  return source.length;
}

/** Everything wrong with one file, in source order. */
export function auditSource(file: string, source: string): Finding[] {
  const masked = maskComments(source);
  const findings: Finding[] = [];

  const report = (index: number, rule: AuditRule, text: string): void => {
    const before = masked.slice(0, index);
    findings.push({
      file,
      line: before.split('\n').length,
      column: index - before.lastIndexOf('\n'),
      rule,
      text,
    });
  };

  if (file.endsWith('.ts') || file.endsWith('.tsx')) {
    for (const { value, index } of classNameValues(masked)) {
      for (const { token, index: tokenIndex } of classTokens(value, index)) {
        if (!isProjectClass(token)) {
          report(tokenIndex, 'bootstrap-class', token);
        }
      }
    }
  }

  /*
   * `data-bs-*` is what a Bootstrap plugin binds itself to; `data-toggle` and its
   * siblings are the same thing under Bootstrap 4's spelling. A screen that
   * reintroduced either would be reintroducing the vendored script.
   */
  for (const match of masked.matchAll(/\bdata-(?:bs-[\w-]+|toggle|target|dismiss|ride|slide)\b/g)) {
    report(match.index ?? 0, 'bootstrap-attribute', match[0]);
  }

  for (const match of masked.matchAll(RETIRED_THEME)) {
    report(match.index ?? 0, 'retired-theme', match[0]);
  }

  return findings;
}

/** Every file the audit reads, as project-relative paths with forward slashes. */
export function collectSourceFiles(root = 'src'): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(relative(process.cwd(), path).split(sep).join('/'));
      }
    }
  };

  walk(root);
  return found.sort();
}

/** Audits a whole tree. Used by the script and by the test suite. */
export function auditTree(root = 'src'): Finding[] {
  return collectSourceFiles(root).flatMap((file) =>
    auditSource(file, readFileSync(file, 'utf8')),
  );
}
