/**
 * Which step of the checkout the customer screen is on.
 *
 * The socket already answers which *stage* is showing (selling, paying, the
 * thank-you); this answers the narrower question the Steps indicator asks:
 * which of its three circles is current. Kept pure and separate from the
 * component so the precedence — money arrived beats a live QR, a live QR beats
 * the bill — is asserted without a browser.
 *
 * `null` means the screen is not at checkout at all (idle, or the collection
 * board), and the Steps hide rather than pointing at a step nobody is on.
 */
export interface CheckoutStepFlags {
  selling: boolean;
  paying: boolean;
  thanks: boolean;
}

export function checkoutStepIndex(flags: CheckoutStepFlags): number | null {
  if (flags.thanks) {
    return 2;
  }
  if (flags.paying) {
    return 1;
  }
  if (flags.selling) {
    return 0;
  }
  return null;
}
