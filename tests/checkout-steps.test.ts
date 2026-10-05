// Seam under test: which step of the checkout the customer screen is on.
//
// The display's stages (idle/selling/paying/ready) are answered by the socket;
// this answers the narrower question the Steps indicator asks at checkout:
// given what the till has said so far — lines on the bill, a live QR, the
// thank-you after money arrived — which of the three circles is current, or
// whether the screen is not at checkout at all (null, and the Steps hide).
import { describe, expect, it } from 'vitest';

import { checkoutStepIndex } from '@/components/display/checkout-step';

describe('the checkout step the display is on', () => {
  it('hides the steps when the screen is not at checkout', () => {
    expect(checkoutStepIndex({ selling: false, paying: false, thanks: false })).toBeNull();
  });

  it('is on step 1 while the bill is being rung up', () => {
    expect(checkoutStepIndex({ selling: true, paying: false, thanks: false })).toBe(0);
  });

  it('moves to step 2 while the QR is live, even with the bill still showing', () => {
    // The till re-pushes the basket the moment the QR appears, so lines and an
    // intent overlap: the payable QR is what the customer acts on, not the bill.
    expect(checkoutStepIndex({ selling: true, paying: true, thanks: false })).toBe(1);
  });

  it('is on step 3 once the money has arrived, whatever is stale', () => {
    expect(checkoutStepIndex({ selling: true, paying: true, thanks: true })).toBe(2);
    expect(checkoutStepIndex({ selling: false, paying: false, thanks: true })).toBe(2);
  });
});
