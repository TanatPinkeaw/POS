/**
 * Payment settlement.
 *
 * Turns a cashier's intent — "155 baht, they handed me a 200" or "200 points
 * plus the rest in cash" — into the concrete rows that go into `payments`, plus
 * the change to hand back.
 *
 * One row per payment leg, deliberately. The SRS enum carries a `mixed` value,
 * but splitting a split payment into a `cash` row and a `points` row keeps the
 * cash-drawer reconciliation in SRS §6.2 honest: `SUM(amount) WHERE method =
 * 'cash'` is then exactly the physical cash in the drawer, with no need to guess
 * which share of a `mixed` row was notes and which was points.
 */
import { ConflictError } from './errors';
import { POINTS_PER_THB_REDEEMED, selectRedeemablePoints, pointsValueThb } from './loyalty';
import { roundThb, toSatang } from './money';

export type PaymentLegMethod = 'cash' | 'promptpay' | 'points';

export interface PaymentLeg {
  method: PaymentLegMethod;
  amount: number;
}

export interface SettlementRequest {
  /** THB applied from the cash drawer. */
  cash?: number;
  /** THB received over PromptPay. */
  promptpay?: number;
  /** Points the customer wishes to redeem; rounded down to a whole block. */
  points?: number;
  /** THB physically handed over, used to work out change. */
  receivedCash?: number;
}

export interface SettlementBreakdown {
  legs: PaymentLeg[];
  /** Points actually redeemed, after block rounding and capping. */
  pointsRedeemed: number;
  /** THB value of the redeemed points — part of `discount_amount`. */
  discountThb: number;
  cashThb: number;
  promptpayThb: number;
  /** Change owed to the customer. */
  changeThb: number;
  /**
   * Cash + PromptPay, i.e. the "final net cash/PromptPay paid amount" that SRS
   * §5.1 awards points on. Redeemed points are not part of it.
   */
  paidAmountThb: number;
}

/** True when the settlement asks for any payment at all. */
function isEmptyRequest(request: SettlementRequest): boolean {
  return (
    !request.cash && !request.promptpay && !request.points && !request.receivedCash
  );
}

/**
 * Builds the settlement for one order.
 *
 * `customerPointsBalance` must be read inside the same transaction that will
 * write the deduction, or a customer could spend the same points twice.
 */
export function buildSettlement(input: {
  amountDueThb: number;
  request: SettlementRequest;
  customerPointsBalance: number;
}): SettlementBreakdown {
  const { request } = input;

  for (const [label, value] of Object.entries({
    cash: request.cash,
    promptpay: request.promptpay,
    points: request.points,
    receivedCash: request.receivedCash,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new ConflictError(
        `Payment amounts cannot be negative or non-finite (received ${label}=${value})`,
        'INVALID_PAYMENT_AMOUNT',
      );
    }
  }

  if (isEmptyRequest(request)) {
    throw new ConflictError(
      'A settlement must apply at least one payment, redemption, or cash handover',
      'EMPTY_SETTLEMENT',
    );
  }

  const amountDue = roundThb(input.amountDueThb);
  const pointsRedeemed = selectRedeemablePoints(
    request.points ?? 0,
    input.customerPointsBalance,
    amountDue,
  );
  const discountThb = pointsValueThb(pointsRedeemed);

  const cashThb = roundThb(request.cash ?? 0);
  const promptpayThb = roundThb(request.promptpay ?? 0);
  const netDue = roundThb(amountDue - discountThb);

  const applied = toSatang(cashThb) + toSatang(promptpayThb);
  if (applied === 0 && pointsRedeemed === 0) {
    throw new ConflictError(
      'A settlement must apply at least one payment, redemption, or cash handover',
      'EMPTY_SETTLEMENT',
    );
  }

  if (applied !== toSatang(netDue)) {
    throw new ConflictError(
      `Payment must cover the amount due exactly: amount due is ${netDue} THB ` +
        `after a ${discountThb} THB points discount, but ${applied / 100} THB was applied`,
      'PAYMENT_MISMATCH',
    );
  }

  const receivedCash =
    request.receivedCash === undefined ? cashThb : roundThb(request.receivedCash);
  const changeThb = roundThb(receivedCash - cashThb);
  if (changeThb < 0) {
    throw new ConflictError(
      `Cash received (${receivedCash} THB) is less than the cash applied ` +
        `(${cashThb} THB), so the change would be negative`,
      'NEGATIVE_CHANGE',
    );
  }

  const legs: PaymentLeg[] = [];
  if (cashThb > 0) {
    legs.push({ method: 'cash', amount: cashThb });
  }
  if (promptpayThb > 0) {
    legs.push({ method: 'promptpay', amount: promptpayThb });
  }
  if (discountThb > 0) {
    legs.push({ method: 'points', amount: discountThb });
  }

  return {
    legs,
    pointsRedeemed,
    discountThb,
    cashThb,
    promptpayThb,
    changeThb,
    paidAmountThb: roundThb(cashThb + promptpayThb),
  };
}

/** True when `points` is a whole 100-point redemption block. */
export function isWholeRedeemBlock(points: number): boolean {
  return Number.isInteger(points) && points > 0 && points % POINTS_PER_THB_REDEEMED === 0;
}
