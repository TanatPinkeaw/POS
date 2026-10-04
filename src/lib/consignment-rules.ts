/**
 * What the shop owes a consignor (ADR 0023 §4, §6).
 *
 * One pure rule, because the share is money owed to somebody outside the shop and it
 * is written from *two* places — a walk-in sale and a pre-order handover (ADR 0023 §5).
 * If each site did its own arithmetic, the two answers could differ, and the difference
 * would only show up as a consignor's balance that does not match their sales. So the
 * arithmetic lives here, is tested without a database, and both write sites call it.
 *
 * Three decisions are load-bearing:
 *
 *   * **The base is the net, excluding VAT.** VAT belongs to the state, not to the shop
 *     or the consignor, so a percentage is taken of what is actually the shop's and the
 *     consignor's to divide (ADR 0023 §4).
 *   * **The share is computed in satang and rounded.** `round(net × percent)` keeps the
 *     consignor's figure a clean percentage; the shop's side is the **remainder**
 *     (`net − share`) and therefore absorbs the last satang in whichever direction the
 *     rounding went. There is no separate rounding argument because there is no second
 *     number to agree — the shop simply takes what is left.
 *   * **A refund and a payout are the same ledger arithmetic, signed.** A sale credits;
 *     a refund claws the credit back; a payout hands the balance over. The balance is
 *     the *sum*, so the only operation that ever moves it is an append (ADR 0023 §2).
 */
import { ValidationError } from './errors';
import { fromSatang, toSatang } from './money';

/** A consignor's share is a whole percentage in this range. */
export const MIN_SHARE_PERCENT = 0;
export const MAX_SHARE_PERCENT = 100;

/**
 * How many links one consignment offer may carry (ADR 0025 §4).
 *
 * Bounded because every one of them is a fetch somebody pays for — and because a
 * member's form has to be told the same number the schema enforces, so the "add
 * another" button disappears rather than letting the server refuse a row the member
 * was still allowed to add. They live in this pure module rather than beside the
 * intake library because the form that counts them is a client component and the
 * library they came from imports the database.
 */
export const MAX_OFFER_PHOTOS = 8;
export const MAX_OFFER_DOCUMENTS = 5;

/**
 * The consignor's share of one sale, to the satang.
 *
 * `netExclVatThb` is the net (excluding VAT) that the consigned line sold for, and
 * `percent` the agreed share. The result is what the shop owes for that line; the shop
 * keeps `net − result`. A non-positive net earns nothing — there is no sale to share.
 */
export function shareFromSale(netExclVatThb: number, percent: number): number {
  if (!Number.isFinite(percent) || percent < MIN_SHARE_PERCENT || percent > MAX_SHARE_PERCENT) {
    throw new ValidationError('ส่วนแบ่งค่าฝากขายต้องอยู่ระหว่าง 0 ถึง 100');
  }

  const netSatang = toSatang(netExclVatThb);
  if (netSatang <= 0) {
    return 0;
  }

  // Integer satang throughout: `netSatang * percent` is exact, and the single rounding
  // is the one the ADR names. The shop's remainder is whatever this leaves behind.
  return fromSatang(Math.round((netSatang * percent) / MAX_SHARE_PERCENT));
}

/**
 * One line's net, excluding VAT, out of the order's own net.
 *
 * The tax snapshot belongs to the order, not to a line: `net_amount` is the whole
 * bill's taxable base *after* any order-level discount, so the only honest way to a
 * single line's net is to allocate the order's net across the lines by what each was
 * charged. Allocating by the pre-discount line total spreads a discount pro-rata,
 * which is the same rule `refund-plan.ts` already uses when a refund has to split an
 * order-level discount — so a consigned line's net and a refund of that line agree.
 *
 * When the shop is not VAT-registered, `netAmountThb` is the whole subtotal and this
 * returns the line total unchanged, which is what a shop with no tax would expect.
 */
export function lineNetExclVat(
  netAmountThb: number,
  lineTotalThb: number,
  subtotalThb: number,
): number {
  const subtotalSatang = toSatang(subtotalThb);
  if (subtotalSatang <= 0) {
    return 0;
  }
  return fromSatang(Math.round((toSatang(netAmountThb) * toSatang(lineTotalThb)) / subtotalSatang));
}

/**
 * The signed debit a refund of a consigned sale writes (ADR 0023 §6).
 *
 * The goods go back to the consignor, so the share goes back with them. Negative by
 * construction — the ledger's CHECK refuses a debit written as a credit — and equal in
 * magnitude to the credit the sale wrote, so refunding the whole line returns the
 * balance exactly to where it was.
 */
export function refundReversal(shareThb: number): number {
  return -Math.abs(toSatang(shareThb)) / 100;
}

/**
 * The share a refund claws back from one consigned line (ADR 0023 §6).
 *
 * `creditedShareThb` is what the sale wrote for the line, `alreadyReversedThb` the
 * magnitude earlier notes have already taken back, and `refundedQty` of `lineQty`
 * units the units *this* note returns. Pro-rata by units, in satang and rounded once,
 * which is the same allocation `lineNetExclVat` uses — a third of a line's units
 * gives back a third of its share.
 *
 * When the note takes the line's last unit the **remainder** is taken instead of a
 * fresh rounding, so however many visits a line comes back in the debits add up to
 * the credit exactly and the balance lands on zero. That is the one rule the discount
 * allocation in `refund-plan.ts` and the points clawback in `credit-notes.ts` already
 * use: every note but the last rounds, and the last settles the difference.
 *
 * Non-negative, because it is a *share*: the caller signs it with `refundReversal`.
 */
export function clawbackFromLine(
  creditedShareThb: number,
  alreadyReversedThb: number,
  refundedQty: number,
  lineQty: number,
  closesLine: boolean,
): number {
  const credited = toSatang(creditedShareThb);
  if (closesLine) {
    return fromSatang(credited - toSatang(alreadyReversedThb));
  }
  if (lineQty <= 0 || refundedQty <= 0) {
    return 0;
  }
  return fromSatang(Math.round((credited * refundedQty) / lineQty));
}

/**
 * The signed debit a payout writes as the shop hands the money over.
 *
 * The mirror of `refundReversal` for the other kind of debit, and it is the *only* way
 * a balance goes down for a reason that is not a refund. Always negative; the caller
 * has already checked the amount against the balance (`assertPayable`).
 */
export function payoutEntry(amountThb: number): number {
  return -Math.abs(toSatang(amountThb)) / 100;
}

/**
 * The balance owed to a consignor: the sum of every signed movement, to the satang.
 *
 * Summed rather than stored, and that is the point — a balance column can drift from
 * the rows that explain it, while a sum cannot. A negative result is meaningful: a
 * payout already made that a later refund has not yet netted against (ADR 0023 §6).
 */
export function ledgerBalance(amountsThb: number[]): number {
  return fromSatang(amountsThb.reduce((total, amount) => total + toSatang(amount), 0));
}

/**
 * Checks that a payout may be taken, and returns the amount to pay.
 *
 * Two refusals, both Thai because this reaches a person at the counter: a payout must
 * be positive (paying nothing is not a payout), and it may not exceed the balance —
 * the shop owes the consignor, and it does not disburse money it has not recorded
 * owing (ADR 0023 §2, §6). The balance it is checked against is the ledger's own sum.
 */
export function assertPayable(balanceThb: number, amountThb: number): void {
  const amount = toSatang(amountThb);
  if (amount <= 0) {
    throw new ValidationError('จำนวนเงินที่จ่ายต้องมากกว่าศูนย์');
  }
  if (amount > toSatang(balanceThb)) {
    throw new ValidationError('ยอดที่จ่ายเกินยอดค้างจ่ายของผู้ฝากขาย');
  }
}
