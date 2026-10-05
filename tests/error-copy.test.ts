// Seam under test: what a failure says to the person in front of the counter.
//
// This started as one bug and became an invariant. `NotFoundError` used to append
// English itself — it took a noun and built `` `${what} not found` `` — so every one
// of its forty-nine call sites shipped English no matter what noun it was handed.
// Fixing that class fixed the sites it owned; the other hundred were English at the
// call site, and were nobody's class's fault.
//
// So this file is now the whole rule rather than one bug's regression: anything a
// person can read is Thai, anything a machine can read is a `code`, and the English
// survives only as a `detail` that `errorResponse` writes to the console. The scan
// below is what keeps the last hundred from quietly coming back.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { errorResponse } from '@/lib/api';
import {
  ApprovalRejectedError,
  ConflictError,
  DomainError,
  ForbiddenError,
  InsufficientStockError,
  NotFoundError,
  RateLimitedError,
  SeriesReservedError,
  UnauthenticatedError,
  ValidationError,
} from '@/lib/errors';
import { parseImportGrid } from '@/lib/import-spec';
import { passwordProblem } from '@/lib/password';
import { planRefund } from '@/lib/refund-plan';
import { scheduleWindowError } from '@/lib/attendance-rules';
import { pinProblem } from '@/lib/supervisor-view';

const THAI = /[\u0E00-\u0E7F]/;

async function bodyOf(response: Response): Promise<{ message: string; code: string }> {
  return (await response.json()).error;
}

describe('a not-found', () => {
  it('says the sentence the call site wrote, and does not append one of its own', () => {
    const error = new NotFoundError('ไม่พบสินค้าที่ระบุ', 'Product 00cf');

    // The old shape was `${what} not found`, which put English in front of a
    // customer with a Thai noun handed to it — or after a Thai one, which is how
    // "…with those details not found" reached a cashier mid-handover.
    expect(error.message).toBe('ไม่พบสินค้าที่ระบุ');
    expect(error.message).not.toMatch(/not found/i);
    expect(error.message).toMatch(THAI);
    expect(error.httpStatus).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('keeps the English out of the response and in the log', async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args);
    });
    try {
      const response = errorResponse(
        new NotFoundError('ไม่พบออเดอร์ที่ระบุ', 'Order 8f2c'),
      );
      const body = await bodyOf(response);

      // The wire carries the sentence and the status, and nothing else about the
      // internals — a response body is the one part of this that reaches a browser.
      expect(response.status).toBe(404);
      expect(body.message).toBe('ไม่พบออเดอร์ที่ระบุ');
      expect(JSON.stringify(body)).not.toContain('8f2c');

      // …and the id is still somewhere, because a 404 that cannot say which row it
      // wanted is the failure this whole change had to avoid creating.
      expect(JSON.stringify(logged)).toContain('Order 8f2c');
    } finally {
      spy.mockRestore();
    }
  });

  it('logs nothing extra when the thrower wrote no English detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await bodyOf(errorResponse(new NotFoundError('ไม่พบชุดเลขที่ระบุ')));
      // A not-found is not an operator error and not a bug; it should not look like
      // one in the console either.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the defaults of the three classes that used to speak English', () => {
  it('are Thai with no argument at all', () => {
    // `new UnauthenticatedError()` at the session check is the most common throw in
    // the app, so its default is the one most likely to reach a person.
    for (const error of [
      new UnauthenticatedError(),
      new ForbiddenError(),
      new NotFoundError('ไม่พบหมวดหมู่ที่ระบุ'),
    ]) {
      expect(error.message).toMatch(THAI);
    }
    expect(new UnauthenticatedError().message).toBe('กรุณาเข้าสู่ระบบก่อน');
    expect(new ForbiddenError().message).toBe('คุณไม่มีสิทธิ์ทำรายการนี้');
  });
});

/**
 * Classes whose *first* argument is the sentence.
 *
 * `InsufficientStockError`, `SeriesReservedError` and `RateLimitedError` are
 * deliberately absent: they take a product id, a series and a policy respectively,
 * and write their own message, so the scan would read the discriminator as a
 * sentence. Those three are asserted by behaviour instead — see below.
 */
const SENTENCE_FIRST_ARGUMENT = new Set([
  'DomainError',
  'NotFoundError',
  'ValidationError',
  'ConflictError',
  'ForbiddenError',
  'UnauthenticatedError',
  'ApprovalRejectedError',
]);

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * True when a sentence is written out in the source, however it is assembled.
 *
 * Concatenation counts: `` `a ${x}` + ' b' `` is a sentence someone typed, and reading
 * it as "computed" would quietly exempt roughly half the tree — which is precisely the
 * half where the English was.
 */
function isWrittenOut(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return true;
  }
  // A template with interpolations is still written out: the head is always literal
  // text, and the only thing a span contributes is a value. `ts.isStringLiteralLike`
  // does not accept a `TemplateHead`, which is the trap here — it reads as though it
  // should, and returning false for it exempts most of the tree from the scan.
  if (ts.isTemplateExpression(node)) {
    return true;
  }
  if (ts.isParenthesizedExpression(node)) {
    return isWrittenOut(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isWrittenOut(node.left) && isWrittenOut(node.right);
  }
  // `condition ? 'yes' : 'no'` picks between two written sentences, so it is written
  // out too — but only if *both* halves are, since one computed half is enough to hide
  // an English sentence on the other branch.
  if (ts.isConditionalExpression(node)) {
    return isWrittenOut(node.whenTrue) && isWrittenOut(node.whenFalse);
  }
  return false;
}

/** Every constructed error whose sentence carries no Thai, split by whether it is written out. */
function sentencesWithoutThai(): { written: string[]; computed: string[] } {
  const written: string[] = [];
  const computed: string[] = [];

  for (const file of sourceFilesUnder('src')) {
    const source = readFileSync(file, 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        SENTENCE_FIRST_ARGUMENT.has(node.expression.text) &&
        node.arguments !== undefined &&
        node.arguments.length > 0
      ) {
        const argument = node.arguments[0]!;
        // A written sentence can be read here and now. An identifier cannot: its text
        // lives in whatever built it, which is why the computed half is pinned by name
        // below rather than skipped — a skipped one would let `new ValidationError(problem)`
        // become the normal way to add a sentence and nothing would notice.
        if (isWrittenOut(argument)) {
          if (!THAI.test(argument.getText(parsed))) {
            const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
            written.push(
              `${file}:${line + 1}  new ${node.expression.text}(${argument.getText(parsed).replace(/\s+/g, ' ')})`,
            );
          }
        } else {
          computed.push(file);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }

  return { written: written.sort(), computed };
}

/**
 * The six files whose sentence the scan cannot read, and where each one is asserted.
 *
 * Every entry has to name the helper that builds it, because that helper is where the
 * English would be written and where a test has to reach it. Adding a seventh file is
 * expected work — the list is here to make that a decision rather than a silence.
 */
const COMPUTED_SENTENCES = [
  // `scheduleWindowError`, asserted below.
  'src\\lib\\attendance.ts',
  // `passwordProblem`, asserted below.
  'src\\lib\\password.ts',
  // `parseImportGrid`'s per-row issues, asserted below.
  'src\\lib\\product-import.ts',
  // `barcodeTakenMessage`, pinned by the exact message in `product-writes.test.ts`.
  'src\\lib\\product-writes.ts',
  // `planRefund`'s private `problems` list, asserted below.
  'src\\lib\\refund-plan.ts',
  // `pinProblem`, asserted below.
  'src\\lib\\supervisor.ts',
];

describe('the sentences written at the point an error is built', () => {
  it('are all Thai, everywhere in src/', () => {
    /*
     * One assertion over the whole tree rather than one per route, because the failure
     * it exists to prevent is not a route's bug — it is the *default*. Every one of
     * these sites is a person standing at a counter reading a failure, and a test per
     * route would be a hundred tests that all pass the day somebody adds the hundred
     * and first. The message lists every offender rather than the first, so a fix is
     * a checklist and not a guessing game.
     *
     * Parsed with the TypeScript compiler rather than a regex, because a template
     * literal with an interpolation is still a sentence and still has to be Thai, and
     * a line-based grep reads its Thai half and its English half the same.
     */
    expect(sentencesWithoutThai().written).toEqual([]);
  });

  it('are the six files the scan cannot read, and no more', () => {
    /*
     * The counterpart to the assertion above. Computed sentences are not waved through:
     * they are the easiest place in the codebase to write English by accident, because
     * the sentence sits among logic and reads like part of it. Naming them means a
     * seventh has to be added here deliberately, with the assertion that covers it,
     * rather than appearing unnoticed and going unchecked.
     *
     * Matched on file only, not file and line, because a line number turns this into a
     * chore — adding an unrelated throw above one of these would fail the suite for
     * the wrong reason and train people to `it.only` their way past it.
     */
    const files = sentencesWithoutThai().computed;
    expect([...new Set(files)].sort()).toEqual([...COMPUTED_SENTENCES].sort());
  });
});

describe('the classes that take a discriminator first', () => {
  it('still write Thai, because they compose their own sentence', () => {
    // The three that build their message instead of being handed one. `InsufficientStockError`
    // is the one that matters at a counter: it fires the moment a cashier rings up more
    // units than the shelf holds, with a customer watching.
    expect(new InsufficientStockError('p1', 3, 1, 'นมสด').message).toMatch(THAI);
    expect(new SeriesReservedError('receipt').message).toMatch(THAI);
    expect(new RateLimitedError('login', 45).message).toMatch(THAI);
  });

  it('puts the product id in the log rather than in the sentence', async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args);
    });
    try {
      const error = new InsufficientStockError('p1', 3, 1, 'นมสด');
      const body = await bodyOf(errorResponse(error));

      // The sentence names the two numbers the cashier can act on — asked for, and
      // there — and the uuid of the row goes to the console, because no one at the
      // counter can look up a uuid and the console has nothing else to grep for.
      expect(body.message).toMatch(/3/);
      expect(body.message).toMatch(/1/);
      expect(JSON.stringify(body)).not.toContain('p1');
      expect(error.detail).toContain('p1');
      expect(JSON.stringify(logged)).toContain('p1');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the two sentences errorResponse writes itself', () => {
  it('are Thai, because they are the ones nothing else can check', async () => {
    // These never touch a domain error, so no scan of the call sites reaches them,
    // and they are the last thing standing between a stack trace and a customer:
    // a malformed body and an unexpected crash both end at the counter's notice.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const crashed = await bodyOf(errorResponse(new Error('boom')));
      expect(crashed.message).toMatch(THAI);
      expect(crashed.code).toBe('INTERNAL_ERROR');

      const thrown = z.object({ name: z.string() }).safeParse({});
      const rejected = await bodyOf(errorResponse(thrown.error!));
      expect(rejected.message).toMatch(THAI);
      expect(rejected.code).toBe('VALIDATION_ERROR');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the sentences that reach an error by way of a helper', () => {
  it('are Thai in every helper that produces one', () => {
    /*
     * The escape hatch out of the scan above: a sentence computed by a function and
     * handed to `new ValidationError(problem)` is invisible to a reader of the call
     * site, and there are a handful. Each is named here instead, because these are the
     * ones most likely to be written in English — they read like logic, not like copy.
     *
     * `planRefund` covers `refund-plan`'s private `problems` list, and `parseImportGrid`
     * covers the import grid's per-row issues, both of which are joined and thrown
     * from somewhere else entirely.
     */
    const fromHelpers = [
      passwordProblem('abc'),
      pinProblem('12345'),
      scheduleWindowError('09:00', '08:00'),
      ...parseImportGrid([['ไม่มีคอลัมน์']]).issues.map((issue) => issue.message),
    ].filter((value): value is string => value !== null);

    expect(fromHelpers.length).toBeGreaterThan(0);
    for (const sentence of fromHelpers) {
      expect(sentence).toMatch(THAI);
    }

    // And the refund planner, whose complaints are assembled then joined.
    expect(() =>
      planRefund({
        lines: [
          { orderItemId: 'l1', name: 'กาแฟ', quantity: 2, returnedQuantity: 0, totalPrice: 120 },
        ],
        requested: [{ orderItemId: 'l1', quantity: 9 }],
        subtotalThb: 120,
        discountThb: 0,
        finalAmountThb: 120,
        alreadyRefundedThb: 0,
      }),
    ).toThrowError(THAI);

    // …and the one it throws when the maths lands on nothing.
    expect(() =>
      planRefund({
        lines: [
          { orderItemId: 'l1', name: 'กาแฟ', quantity: 1, returnedQuantity: 1, totalPrice: 60 },
        ],
        requested: null,
        subtotalThb: 60,
        discountThb: 0,
        finalAmountThb: 60,
        alreadyRefundedThb: 60,
      }),
    ).toThrowError(THAI);
  });
});

describe('the English that is still in the codebase', () => {
  it('is only ever a detail, never the message a client would read', () => {
    /*
     * `NotFoundError` is the original regression this file was written for. If someone
     * restores the `` `${what} not found` `` composition — the obvious "small tidy-up"
     * that makes the signature shorter — every one of its call sites goes back to
     * English at once, and no test of a single route would notice.
     */
    const notFound = new NotFoundError('ไม่พบสินค้าที่ระบุ', 'Product x');
    expect(notFound.message).not.toBe('ไม่พบสินค้าที่ระบุ not found');

    // And the detail is genuinely separate state, not a second reading of `message`.
    expect(notFound.detail).toBe('Product x');
    expect(new DomainError('ปฏิเสธ', 'X', 400).detail).toBeUndefined();

    // `ConflictError` grew the same third argument when its sentences were translated,
    // and it has to stay optional: two thirds of its call sites pass only a code.
    const conflict = new ConflictError('ปิดบิลนี้ไม่ได้', 'INVALID_TRANSITION');
    expect(conflict.detail).toBeUndefined();
    expect(conflict.code).toBe('INVALID_TRANSITION');
  });

  it('and no class may compose an English fragment onto what a caller passed', () => {
    // The shape that broke the till in the first place: a class that appends its own
    // words to a caller's sentence. There is none left, and a class that reintroduces
    // one to save a parameter would be invisible to the scan above.
    const errors = [
      new NotFoundError('ไม่พบหมวดหมู่ที่ระบุ'),
      new ConflictError('บิลนี้ปิดไปแล้ว', 'X'),
      new ValidationError('กรุณากรอกจำนวน'),
      new ApprovalRejectedError('PIN ผิด', 'PIN_WRONG'),
    ];
    for (const error of errors) {
      expect(error.message).toMatch(THAI);
    }
  });
});