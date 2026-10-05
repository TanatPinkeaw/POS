// Seam under test: what a failure says to the person in front of the counter.
//
// A not-found used to read "Product <uuid> not found" in the till's error notice,
// because `NotFoundError` appended the English itself — every one of its call sites
// shipped English no matter what noun it was handed. These are the assertions that
// hold that door shut: the sentence is Thai, the debugging half is the server's, and
// the class cannot go back to composing a message out of a noun.
import { describe, expect, it, vi } from 'vitest';

import { errorResponse } from '@/lib/api';
import {
  DomainError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from '@/lib/errors';

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

describe('the English that is still in the codebase', () => {
  it('is only ever a detail, never the message a client would read', () => {
    /*
     * The remaining ~180 error messages are English sentences the call sites wrote
     * themselves, and converting all of them is a separate piece of work. What is
     * asserted here is the invariant that keeps them from being *this* bug again:
     * whatever a class builds for itself has to be a sentence the app can show, and
     * nothing may compose an English fragment onto whatever a caller passed in.
     *
     * `NotFoundError` is the regression this was written for. If someone restores the
     * `` `${what} not found` `` composition — the obvious "small tidy-up" that makes
     * the signature shorter — every one of its call sites goes back to English at
     * once, and no test of a single route would notice.
     */
    const notFound = new NotFoundError('ไม่พบสินค้าที่ระบุ', 'Product x');
    expect(notFound.message).not.toBe('ไม่พบสินค้าที่ระบุ not found');

    // And the detail is genuinely separate state, not a second reading of `message`.
    expect(notFound.detail).toBe('Product x');
    expect(new DomainError('ปฏิเสธ', 'X', 400).detail).toBeUndefined();
  });
});