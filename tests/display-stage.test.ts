// Seam under test: which single stage the customer screen is on.
//
// This exists because the screen used to decide each stage with its own
// independent `!paying && !selling && …` condition, and two of them could be
// true at once. Both failures were seen on a real paired screen: a stale bill
// snapshot suppressed the receipt QR the cashier had just pushed (the event
// arrived, nothing drew it), and once the bill cleared the receipt drew *on top
// of* the idle welcome, because the idle stage never excluded it. One function
// decides, so "exactly one stage" is a property a test can hold.
import { describe, expect, it } from 'vitest';

import { displayStage } from '@/components/display/display-stage';

describe('a live payment QR', () => {
  it('outranks everything, because money is in flight', () => {
    const stage = displayStage({
      hasPaymentQr: true,
      hasReceipt: true,
      lineCount: 3,
      hasReadyBoard: true,
    });

    expect(stage).toBe('paying');
  });
});

describe('a receipt the cashier pushed to the screen', () => {
  it('outranks a leftover bill, so the QR is not silently swallowed', () => {
    // The measured failure: the till had pushed a basket earlier, the display
    // still held those lines, and the receipt never appeared.
    const stage = displayStage({
      hasPaymentQr: false,
      hasReceipt: true,
      lineCount: 3,
      hasReadyBoard: false,
    });

    expect(stage).toBe('receipt');
  });

  it('outranks the collection board, rather than drawing both at once', () => {
    const stage = displayStage({
      hasPaymentQr: false,
      hasReceipt: true,
      lineCount: 0,
      hasReadyBoard: true,
    });

    expect(stage).toBe('receipt');
  });
});

describe('the stages below the receipt', () => {
  it('is the bill when there are lines and no receipt', () => {
    expect(
      displayStage({ hasPaymentQr: false, hasReceipt: false, lineCount: 2, hasReadyBoard: true }),
    ).toBe('selling');
  });

  it('is the collection board when the screen is otherwise idle', () => {
    expect(
      displayStage({ hasPaymentQr: false, hasReceipt: false, lineCount: 0, hasReadyBoard: true }),
    ).toBe('ready');
  });

  it('is idle when there is nothing to show', () => {
    expect(
      displayStage({ hasPaymentQr: false, hasReceipt: false, lineCount: 0, hasReadyBoard: false }),
    ).toBe('idle');
  });
});
