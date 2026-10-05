// Seam under test: turning a payment request into concrete payment legs.
// The amount due must be covered exactly, change is computed from what was
// handed over, and points are only ever redeemed in whole 100-point blocks.
import { describe, expect, it } from 'vitest';

import { buildSettlement } from '@/lib/settlement';

describe('cash settlement', () => {
  it('computes change from the notes handed over', () => {
    const result = buildSettlement({
      amountDueThb: 155,
      request: { cash: 155, receivedCash: 200 },
      customerPointsBalance: 0,
    });

    expect(result.changeThb).toBe(45);
    expect(result.legs).toEqual([{ method: 'cash', amount: 155 }]);
    expect(result.paidAmountThb).toBe(155);
  });

  it('treats an exact payment as no change', () => {
    const result = buildSettlement({
      amountDueThb: 89,
      request: { cash: 89, receivedCash: 89 },
      customerPointsBalance: 0,
    });
    expect(result.changeThb).toBe(0);
  });

  it('rejects handing over less cash than is being applied', () => {
    expect(() =>
      buildSettlement({
        amountDueThb: 155,
        request: { cash: 155, receivedCash: 100 },
        customerPointsBalance: 0,
      }),
    ).toThrow(/เงินทอนจึงติดลบ/);
  });

  it('allows the drawer to be short only when the difference is paid another way', () => {
    expect(() =>
      buildSettlement({
        amountDueThb: 155,
        request: { cash: 100 },
        customerPointsBalance: 0,
      }),
    ).toThrow(/ต้องตรงกับยอดที่ต้องจ่ายพอดี/);
  });
});

describe('promptpay settlement', () => {
  it('records a single promptpay leg with no change', () => {
    const result = buildSettlement({
      amountDueThb: 240,
      request: { promptpay: 240 },
      customerPointsBalance: 0,
    });

    expect(result.legs).toEqual([{ method: 'promptpay', amount: 240 }]);
    expect(result.changeThb).toBe(0);
    expect(result.paidAmountThb).toBe(240);
  });
});

describe('points redemption', () => {
  it('turns 200 points into a 2 THB discount and earns no points', () => {
    // SRS §5.1: 100 points = 1 THB.
    const result = buildSettlement({
      amountDueThb: 100,
      request: { points: 200, cash: 98, receivedCash: 100 },
      customerPointsBalance: 500,
    });

    expect(result.pointsRedeemed).toBe(200);
    expect(result.discountThb).toBe(2);
    expect(result.paidAmountThb).toBe(98);
    expect(result.changeThb).toBe(2);
    expect(result.legs).toEqual([
      { method: 'cash', amount: 98 },
      { method: 'points', amount: 2 },
    ]);
  });

  it('covers the whole bill when points alone are enough', () => {
    const result = buildSettlement({
      amountDueThb: 3,
      request: { points: 300 },
      customerPointsBalance: 300,
    });

    expect(result.pointsRedeemed).toBe(300);
    expect(result.paidAmountThb).toBe(0);
  });

  it('rounds the request down to a whole block instead of refusing it', () => {
    const result = buildSettlement({
      amountDueThb: 50,
      request: { points: 250, cash: 48, receivedCash: 48 },
      customerPointsBalance: 250,
    });
    expect(result.pointsRedeemed).toBe(200);
  });

  it('caps redemption at the customer balance', () => {
    const result = buildSettlement({
      amountDueThb: 50,
      request: { points: 1000, cash: 49, receivedCash: 49 },
      customerPointsBalance: 100,
    });
    expect(result.pointsRedeemed).toBe(100);
    expect(result.discountThb).toBe(1);
  });

  it('caps redemption so the bill can never go negative', () => {
    const result = buildSettlement({
      amountDueThb: 2,
      request: { points: 500 },
      customerPointsBalance: 500,
    });
    // Only 2 whole THB of discount is available, so 200 points.
    expect(result.pointsRedeemed).toBe(200);
    expect(result.paidAmountThb).toBe(0);
  });
});

describe('validation', () => {
  it('refuses an empty settlement', () => {
    expect(() =>
      buildSettlement({ amountDueThb: 10, request: {}, customerPointsBalance: 0 }),
    ).toThrow(/อย่างน้อย 1 อย่าง/);
  });

  it('refuses a negative amount', () => {
    expect(() =>
      buildSettlement({
        amountDueThb: 10,
        request: { cash: -10 },
        customerPointsBalance: 0,
      }),
    ).toThrow(/ต้องไม่ติดลบ/);
  });

  it('refuses points for a walk-in customer with no account', () => {
    expect(() =>
      buildSettlement({
        amountDueThb: 10,
        request: { points: 100, cash: 9 },
        customerPointsBalance: 0,
      }),
    ).toThrow(/ต้องตรงกับยอดที่ต้องจ่ายพอดี/);
  });
});
