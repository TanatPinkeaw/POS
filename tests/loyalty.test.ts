// Seam under test: the loyalty rules from SRS §5.1, as pure functions.
// Expected values come from the spec's worked rules, not from re-deriving them
// the way the implementation does.
import { describe, expect, it } from 'vitest';

import {
  POINTS_PER_THB_REDEEMED,
  REDEEM_BLOCK,
  pointsEarned,
  pointsValueThb,
  selectRedeemablePoints,
} from '@/lib/loyalty';

describe('loyalty constants', () => {
  it('encode the SRS §5.1 exchange rates', () => {
    expect(REDEEM_BLOCK).toBe(100);
    expect(POINTS_PER_THB_REDEEMED).toBe(100);
  });
});

describe('pointsEarned', () => {
  it('awards 1 point per 3 THB, rounded down', () => {
    // SRS §5.1: Points Earned = floor(Final Paid Amount / 3)
    expect(pointsEarned(0)).toBe(0);
    expect(pointsEarned(2.99)).toBe(0);
    expect(pointsEarned(3)).toBe(1);
    expect(pointsEarned(5.99)).toBe(1);
    expect(pointsEarned(6)).toBe(2);
    expect(pointsEarned(299)).toBe(99);
    expect(pointsEarned(300)).toBe(100);
  });

  it('treats a negative or non-finite paid amount as 0 points', () => {
    expect(pointsEarned(-9)).toBe(0);
    expect(pointsEarned(Number.NaN)).toBe(0);
    expect(pointsEarned(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('pointsValueThb', () => {
  it('values 100 points at exactly 1 THB', () => {
    expect(pointsValueThb(100)).toBe(1);
    expect(pointsValueThb(250)).toBe(2.5);
    expect(pointsValueThb(0)).toBe(0);
  });
});

describe('selectRedeemablePoints', () => {
  it('accepts the largest multiple of 100 that the balance allows', () => {
    // SRS §5.1: minimum redeem block is 100 points.
    expect(selectRedeemablePoints(250, 250, 1000)).toBe(200);
    expect(selectRedeemablePoints(1000, 250, 1000)).toBe(200);
  });

  it('never redeems more than the requested amount', () => {
    expect(selectRedeemablePoints(120, 1000, 1000)).toBe(100);
    expect(selectRedeemablePoints(99, 1000, 1000)).toBe(0);
  });

  it('never discounts more than the order total', () => {
    // 400 points would be 4 THB, but the order only costs 1.50 THB.
    expect(selectRedeemablePoints(400, 1000, 1.5)).toBe(100);
    expect(selectRedeemablePoints(400, 1000, 1)).toBe(100);
    expect(selectRedeemablePoints(400, 1000, 0.99)).toBe(0);
  });

  it('refuses a partial block, a negative request, or a zero balance', () => {
    expect(selectRedeemablePoints(150, 1000, 1000)).toBe(100);
    expect(selectRedeemablePoints(-100, 1000, 1000)).toBe(0);
    expect(selectRedeemablePoints(100, 0, 1000)).toBe(0);
  });
});
