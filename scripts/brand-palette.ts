/**
 * Writes the generated brand ramp into the design tokens — `npm run brand:palette`.
 *
 * The ramp itself lives in `src/lib/palette.ts`, where it is unit-tested. This
 * file is only the part that cannot be: reading and rewriting a stylesheet, and
 * reporting whether the checked-in copy is stale.
 *
 *   npm run brand:palette            rewrite the block
 *   npm run brand:palette -- --check exit 1 if it is stale (used by `npm run verify`)
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { BRAND_ANCHORS } from '../src/brand/brand';
import { primaryAnchor, RAMP_END, RAMP_START, renderRampBlock } from '../src/lib/palette';

const TOKENS_PATH = 'src/design/tokens.css';

function main(): void {
  const check = process.argv.includes('--check');
  const source = readFileSync(TOKENS_PATH, 'utf8');

  const start = source.indexOf(RAMP_START);
  const end = source.indexOf(RAMP_END);
  if (start === -1 || end === -1 || end < start) {
    console.error(`${TOKENS_PATH} is missing its ramp markers (${RAMP_START} / ${RAMP_END}).`);
    process.exit(1);
  }

  const block = renderRampBlock(BRAND_ANCHORS);
  const current = source.slice(start + RAMP_START.length, end).trim();

  if (current === block) {
    console.log(`brand palette: up to date (primary ${primaryAnchor(BRAND_ANCHORS)})`);
    return;
  }

  if (check) {
    console.error(
      `brand palette is stale.\n  anchors in src/brand/brand.ts: ${BRAND_ANCHORS.join(', ')}` +
        `\n  run: npm run brand:palette`,
    );
    process.exit(1);
  }

  writeFileSync(TOKENS_PATH, `${source.slice(0, start + RAMP_START.length)}\n${block}\n${source.slice(end)}`);
  console.log(`brand palette: rewrote ${TOKENS_PATH} from ${BRAND_ANCHORS.length} anchors`);
}

main();
