// Seam under test: the report an operator reads before believing LINE works (ADR 0035).
//
// The wizard's old summary line was `messagingSecret && pushToken ? '✓ webhook + push
// ลูกค้า: พร้อม'`. Both of those values were set on shops where the customer's "order
// ready" message still never left, because `orders.ts` gates it on `NOTIFY_CHANNEL=line`
// as well — a third value the wizard never read. An operator following the tool would
// conclude the shop was notifying customers and have no way to find out otherwise.
//
// So this pins the shape rather than the wording: the report must come from the shared
// module (one rule, two readers), and the old sentence must not come back. It is the same
// kind of source assertion `google-setup-script.test.ts` makes for a deploy script, and
// for the same reason: a tool that reports a phantom state is worse than no tool.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const script = (): string => readFileSync('scripts/line-wizard.ts', 'utf8');

describe('the LINE wizard report', () => {
  it('asks the shared readiness module rather than deciding for itself', () => {
    const source = script();

    expect(source).toContain("from '../src/lib/line-readiness'");
    expect(source).toContain('lineReadiness(env)');
  });

  it('no longer calls the customer push ready from a token and a secret', () => {
    const source = script();

    // The printed literal, and the condition that produced it. The docstring above still
    // quotes the old sentence, deliberately: a reader deserves to know what was wrong.
    expect(source).not.toContain("'  ✓ webhook + push");
    expect(source).not.toContain('messagingSecret && pushToken');
  });

  it('tells the operator that the file and the running process can disagree', () => {
    // The wizard reads `.env`; the server holds what it read at boot. A shop that edits
    // the file, sees `✓` here and still sends nothing has been misled by the tool.
    expect(script()).toContain('/admin/line');
    expect(script()).toContain('รีสตาร์ตเซิร์ฟเวอร์');
  });
});
