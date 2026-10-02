// Seam under test: what the shop owes a consignor, and how a refund and a payout move it
// (ADR 0023 §4, §6).
//
// This is the arithmetic that ends up in somebody else's pocket, and it is written from
// two different sale sites — so the property under test is not "this number is 33" but
// the invariants: the share is a percentage of the *net*, the parts add back up to the
// net, and a payout can never hand over more than the ledger says is owed.
import { describe, expect, it } from 'vitest';

import {
  assertPayable,
  ledgerBalance,
  payoutEntry,
  refundReversal,
  shareFromSale,
} from '@/lib/consignment-rules';
import { ValidationError } from '@/lib/errors';
import { roundThb } from '@/lib/money';

describe('the consignor share of a sale', () => {
  it('is the agreed percentage of the net', () => {
    expect(shareFromSale(100, 60)).toBe(60);
    expect(shareFromSale(107, 33)).toBe(35.31);
  });

  it('leaves the remainder — a satang and all — to the shop', () => {
    // ฿100.01 at 33% is ฿33.0033; rounded, the consignor takes ฿33.00 and the extra
    // satang is the shop's. The parts still add back up to what the customer paid.
    const net = 100.01;
    const share = shareFromSale(net, 33);
    expect(share).toBe(33);
    expect(roundThb(net - share)).toBe(67.01);
  });

  it('never gives the consignor more than the net, whatever the percentage', () => {
    for (const percent of [0, 1, 50, 99, 100]) {
      const share = shareFromSale(19.99, percent);
      expect(share).toBeLessThanOrEqual(19.99);
      expect(share).toBeGreaterThanOrEqual(0);
    }
  });

  it('earns nothing on a non-positive net', () => {
    expect(shareFromSale(0, 50)).toBe(0);
    expect(shareFromSale(-10, 50)).toBe(0);
  });

  it('refuses a percentage outside 0–100', () => {
    for (const percent of [-1, 101, NaN, Infinity]) {
      expect(() => shareFromSale(100, percent)).toThrow(ValidationError);
    }
  });
});

describe('a refund and a payout over the ledger', () => {
  it('claws a refund back, so refunding the whole sale returns the balance to zero', () => {
    const share = shareFromSale(107, 33);
    const balance = ledgerBalance([share, refundReversal(share)]);
    expect(balance).toBe(0);
  });

  it('writes a payout as a debit, and the balance is the sum of movements', () => {
    const balance = ledgerBalance([60, payoutEntry(25), shareFromSale(107, 50)]);
    expect(balance).toBe(60 - 25 + 53.5);
  });

  it('tolerates a negative balance, which a refund after a payout produces', () => {
    // ADR 0023 §6: a sale credited ฿60, the shop then paid that ฿60 out, and the sale
    // was refunded — the balance goes negative and the next payout nets against it
    // rather than the debt quietly disappearing.
    const balance = ledgerBalance([
      shareFromSale(100, 60),
      payoutEntry(60),
      refundReversal(60),
    ]);
    expect(balance).toBe(-60);
  });
});

describe('checking a payout against the balance', () => {
  it('allows paying the balance exactly', () => {
    expect(() => assertPayable(60, 60)).not.toThrow();
  });

  it('refuses more than the balance', () => {
    expect(() => assertPayable(60, 60.01)).toThrow(ValidationError);
  });

  it('refuses a payout that is not positive', () => {
    expect(() => assertPayable(60, 0)).toThrow(ValidationError);
    expect(() => assertPayable(60, -5)).toThrow(ValidationError);
  });
});
