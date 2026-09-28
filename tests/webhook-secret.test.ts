// Seam under test: the comparison two machine-only endpoints trust.
//
// A shared secret is the only thing standing between the internet and the ability
// to confirm a bill as paid, so the comparison is worth pinning: it must not leak
// an answer one byte at a time, and it must fail closed when either side is
// missing or empty — an unset `PAYMENT_WEBHOOK_SECRET` that accepted an empty
// header would make every shop that never configured one wide open.
import { describe, expect, it } from 'vitest';

import { secretMatches } from '@/lib/webhook-secret';

describe('comparing a shared secret', () => {
  it('accepts exactly the configured secret', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true);
  });

  it('rejects a different value of the same length', () => {
    expect(secretMatches('s3creX', 's3cret')).toBe(false);
  });

  it('rejects a prefix, a suffix and an extension', () => {
    for (const provided of ['s3cre', '3cret', 's3cretx', 'xS3cret']) {
      expect(secretMatches(provided, 's3cret'), provided).toBe(false);
    }
  });

  it('fails closed when nothing is configured', () => {
    // The important case: an unconfigured shop must refuse machine confirmations,
    // not accept everything.
    expect(secretMatches('anything', null)).toBe(false);
    expect(secretMatches('anything', undefined)).toBe(false);
    expect(secretMatches('anything', '')).toBe(false);
  });

  it('fails closed when nothing was presented', () => {
    expect(secretMatches(null, 's3cret')).toBe(false);
    expect(secretMatches('', 's3cret')).toBe(false);
  });

  it('does not throw on values of different lengths', () => {
    // `timingSafeEqual` throws on mismatched buffers, and an exception in the
    // guard would be a 500 rather than a refusal.
    expect(() => secretMatches('short', 'a-much-longer-secret')).not.toThrow();
    expect(secretMatches('short', 'a-much-longer-secret')).toBe(false);
  });
});
