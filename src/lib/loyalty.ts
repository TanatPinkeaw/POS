/**
 * Loyalty points rules — SRS §5.1.
 *
 * Earning  : every 3 THB spent earns 1 point, rounded down.
 * Redeeming: 100 points = 1 THB, only in whole 100-point blocks.
 *
 * Everything here is a pure function of its arguments so the money rules can be
 * tested without a database, and so an order can be priced before it is written.
 */

/** THB that must be spent to earn a single point. */
export const THB_PER_POINT = 3;

/** Points that buy one THB of discount. */
export const POINTS_PER_THB_REDEEMED = 100;

/** Smallest number of points that may be redeemed at once. */
export const REDEEM_BLOCK = 100;

/** Rounds a currency amount to satang, killing binary-floating-point drift. */
function toSatang(amount: number): number {
  return Math.round(amount * 100) / 100;
}

/**
 * Points awarded for a settled payment.
 *
 * The caller passes the amount actually collected in cash/PromptPay — the SRS
 * is explicit that points are earned on the net paid amount and not on the
 * discounted portion of the bill.
 */
export function pointsEarned(paidAmountThb: number): number {
  if (!Number.isFinite(paidAmountThb) || paidAmountThb <= 0) {
    return 0;
  }
  return Math.floor(paidAmountThb / THB_PER_POINT);
}

/** THB value of a points balance. 100 points = 1 THB. */
export function pointsValueThb(points: number): number {
  if (!Number.isFinite(points) || points <= 0) {
    return 0;
  }
  return toSatang(points / POINTS_PER_THB_REDEEMED);
}

/** Truncates a points figure down to the nearest whole 100-point block. */
function toWholeBlock(points: number): number {
  if (!Number.isFinite(points) || points <= 0) {
    return 0;
  }
  return Math.floor(points / REDEEM_BLOCK) * REDEEM_BLOCK;
}

/**
 * The number of points that may actually be redeemed on an order.
 *
 * Bounded by three things at once: what the customer asked for, what their
 * balance can cover, and how much of the order there is left to discount. A
 * redemption can never exceed the order total, because a negative bill cannot
 * be paid out of a cash drawer.
 */
export function selectRedeemablePoints(
  requestedPoints: number,
  balance: number,
  orderTotalThb: number,
): number {
  const requestedBlock = toWholeBlock(requestedPoints);
  if (requestedBlock === 0) {
    return 0;
  }

  const balanceBlock = toWholeBlock(balance);
  if (balanceBlock === 0) {
    return 0;
  }

  // Whole THB of discount the order can absorb, expressed back in points.
  const orderCeiling =
    Number.isFinite(orderTotalThb) && orderTotalThb > 0
      ? Math.floor(orderTotalThb) * REDEEM_BLOCK
      : 0;

  return Math.max(0, Math.min(requestedBlock, balanceBlock, orderCeiling));
}
