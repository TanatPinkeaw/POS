// Seam under test: what a Thai receipt prints for money received.
//
// `รับเงิน` is what the customer handed over, not what the settlement applied to
// the bill. A ฿35 sale paid with a ฿100 note must print 100.00 beside a 65.00
// change line; a single 35.00 above a 65.00 change is a document that does not
// add up, which is the defect these helpers exist to prevent.
import { describe, expect, it } from 'vitest';

import { tenderedAmount, tenderLabel, type TenderLine } from '@/lib/tender';

const cash = (amountThb: number, receivedThb: number | null): TenderLine => ({
  method: 'cash',
  amountThb,
  receivedThb,
});

describe('what a tender line prints', () => {
  it('prints the notes handed over, not the amount applied', () => {
    expect(tenderedAmount(cash(35, 100))).toBe(100);
  });

  it('falls back to the applied amount when nothing extra changed hands', () => {
    expect(tenderedAmount(cash(35, null))).toBe(35);
  });

  it('prints a transfer as the amount transferred', () => {
    expect(tenderedAmount({ method: 'promptpay', amountThb: 250, receivedThb: null })).toBe(250);
  });

  it('keeps the tender line and the change line subtracting to the bill', () => {
    // 100 handed over − 65 change = the 35 bill.
    expect(tenderedAmount(cash(35, 100)) - 65).toBe(35);
  });
});

describe('what a tender line is called', () => {
  it('names cash as cash', () => {
    expect(tenderLabel('cash')).toBe('รับเงินสด');
  });

  it('names a transfer as a transfer, so it is never read as cash', () => {
    expect(tenderLabel('promptpay')).toBe('รับโอน (พร้อมเพย์)');
  });

  it('falls back to a neutral label for a method it does not know', () => {
    expect(tenderLabel('voucher')).toBe('รับเงิน');
  });
});
