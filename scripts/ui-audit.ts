/**
 * `npm run ui:audit` — fails the build if the retired theme comes back.
 *
 * ADR 0003 lists three things that must not reappear in `src/`: a Bootstrap class
 * name, a `data-bs-*` attribute, and a `/hope-ui/` reference. This is the command
 * that checks it, and the reason it exists at all is that the failure it prevents
 * is silent: the markup still compiles, the stylesheet is simply gone, and the
 * screen renders unstyled.
 *
 * The detection itself lives in `src/lib/ui-audit.ts`, where it is unit-tested
 * both against samples and against this repository's own tree. This file is only
 * the part that cannot be tested that way: walking the filesystem and printing a
 * report a person can act on.
 */
import { readFileSync } from 'node:fs';

import { auditSource, collectSourceFiles, type Finding } from '../src/lib/ui-audit';

const ROOT = 'src';

function main(): void {
  const files = collectSourceFiles(ROOT);
  const findings: Finding[] = files.flatMap((file) =>
    auditSource(file, readFileSync(file, 'utf8')),
  );

  if (findings.length === 0) {
    console.log(
      `ui audit: clean — ${files.length} files under ${ROOT}/ carry no Bootstrap ` +
        'class, no data-bs-* attribute and no /hope-ui/ reference',
    );
    return;
  }

  console.error(`ui audit: ${findings.length} finding(s) — the retired theme is back.`);
  console.error('');
  for (const finding of findings) {
    console.error(
      `  ${finding.file}:${finding.line}:${finding.column}  ${finding.rule}  "${finding.text}"`,
    );
  }
  console.error('');
  console.error('  The design system is the only styling layer (ADR 0003). Use a component');
  console.error('  from @/components/ds, an ln-* utility class, or a CSS module — not a');
  console.error('  Bootstrap class name, and not the vendored theme.');
  process.exit(1);
}

main();
