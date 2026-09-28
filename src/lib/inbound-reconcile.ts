/**
 * Did the money that arrived become a bill?
 *
 * Every PromptPay transfer leaves two traces, and until now nothing compared
 * them: the bank's confirmation (`inbound_payments`, `matched`) and the bill that
 * closed on it (`payment_intents`, `consumed`). Read separately they are two
 * lists; read together they answer the one question that matters at closing time,
 * which is whether anything came in that never became a sale.
 *
 * **Both readings of a difference are real, and this module refuses to pretend
 * otherwise.** A transfer can be confirmed and close nothing because the till
 * never finished the sale — that is an error worth chasing. It can also close a
 * bill with no notification at all, because a cashier confirmed it by hand after
 * looking at the banking app (which is what a shop without a bridge does all day
 * long). So the verdict is a *fact* — which side is larger — and never a
 * conclusion; `inbound-transfer-view.ts` owns the sentences that explain the two
 * causes, and the screen shows the transfers themselves beside them.
 *
 * Pure, and satang-rounded, because this is arithmetic about money rather than a
 * screen's decoration.
 */
export interface TransferReconciliation {
  /** Money a bank notification confirmed on the day. */
  confirmedThb: number;
  /** QR transfers that closed a bill on the day, however they were confirmed. */
  closedThb: number;
  /** `confirmed − closed`, signed by which side is larger. */
  differenceThb: number;
  verdict: TransferReconciliationVerdict;
}

export type TransferReconciliationVerdict =
  /** The same money, seen twice. */
  | 'balanced'
  /** More arrived than was billed with: something did not become a sale. */
  | 'confirmed_more'
  /** More was billed than arrived: a transfer confirmed by hand, not by a bank. */
  | 'closed_more';

export function reconcileTransfers(input: {
  confirmedThb: number;
  closedThb: number;
}): TransferReconciliation {
  /*
   * Rounded before comparison, not after, and to the satang: a float artefact
   * between 107.10 and 107.1 is not a discrepancy, while a single satang
   * genuinely is. The same rule the rest of the money code follows.
   */
  const confirmedThb = roundToSatang(input.confirmedThb);
  const closedThb = roundToSatang(input.closedThb);
  const differenceThb = roundToSatang(confirmedThb - closedThb);

  return {
    confirmedThb,
    closedThb,
    differenceThb,
    verdict:
      differenceThb === 0 ? 'balanced' : differenceThb > 0 ? 'confirmed_more' : 'closed_more',
  };
}

function roundToSatang(amountThb: number): number {
  return Math.round(amountThb * 100) / 100;
}
