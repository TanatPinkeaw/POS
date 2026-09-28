/**
 * Which bill did that transfer pay?
 *
 * A bank notification is an amount, some prose, and a timestamp. Somewhere in the
 * prose, if the customer typed it, is the reference printed under the QR. This
 * module decides whether that is enough to close a bill — and it is a pure
 * function, with no clock and no database, because it is the one step in the
 * automatic path where being wrong puts money on somebody else's receipt, and
 * every way it can be wrong is worth being able to enumerate.
 *
 * **It never guesses.** Three refusals carry that promise:
 *
 *   * An amount on its own is not evidence. Two customers in one queue can owe
 *     107.00, and the QR's own reference is the only thing that says which bill.
 *     Single-candidate amount matches are refused (`no_reference`) even when the
 *     till has exactly one QR open, because "there was only one" is a fact about
 *     the moment, not about the transfer.
 *   * A notification naming two references is refused (`ambiguous`) rather than
 *     resolved by the first one found.
 *   * Money that arrives after the payable window closed is refused
 *     (`not_payable`) — including money for a bill that was already paid, which
 *     is what a retrying bridge sends the second time.
 *
 * Everything refused here becomes a recorded, visible transfer rather than a lost
 * one: see `inbound-payments.ts`.
 */

/** What the bank told us. `receivedAt` is the bank's instant, not ours. */
export interface InboundTransfer {
  amountThb: number;
  /** The notification's own text: the memo, the payer's name, the whole body. */
  text: string;
  receivedAt: Date;
}

/**
 * A QR that could have been the one paid, as the matcher needs to see it.
 *
 * A narrowed view of `payment_intents` on purpose: the matcher must not be able
 * to read the QR payload, the amount as a `Decimal`, or anything else it has no
 * business deciding on.
 */
export interface IntentCandidate {
  ref: string;
  amountThb: number;
  status: 'pending' | 'paid' | 'consumed' | 'expired' | 'cancelled';
  expiresAt: Date;
}

/**
 * Why a transfer could not be attributed.
 *
 * Kept as a small closed set because each one is a different sentence to the
 * person who has to sort it out: `amount_unreadable` means the shop's own pattern
 * did not recognise the notification, `no_amount_match` is usually a mistyped
 * amount, `no_reference` is usually a customer who typed nothing in the memo,
 * `ambiguous` is a genuine puzzle, and `not_payable` is usually the second half
 * of a duplicate notification.
 *
 * `amount_unreadable` is decided by the *bridge* (`scripts/bank-bridge.ts`) and
 * not by `matchInboundTransfer` below, which cannot be called without an amount.
 * It is still listed here because this is the set the record and the screen are
 * built from, and a reason that exists only in a script would be a reason no
 * screen could show.
 */
export type InboundRefusalReason =
  | 'amount_unreadable'
  | 'no_amount_match'
  | 'no_reference'
  | 'ambiguous'
  | 'not_payable';

export type InboundMatch =
  | { matched: true; ref: string }
  | { matched: false; reason: InboundRefusalReason; refs: string[] };

/**
 * Decides the bill, or refuses to.
 *
 * `refs` on a refusal is not decoration: it is what the screen shows a person so
 * they can finish the job by hand, and it is why a refusal is a result rather
 * than an exception.
 */
export function matchInboundTransfer(
  transfer: InboundTransfer,
  candidates: readonly IntentCandidate[],
): InboundMatch {
  /*
   * Amount first, and in satang. Both sides are rounded to the smallest unit the
   * money actually has before they are compared, so a float artefact cannot make
   * two identical amounts look different — and a single satang of difference is
   * a different bill, which is exactly right: the bank is vouching for the number
   * it printed.
   */
  const wanted = toSatang(transfer.amountThb);
  const byAmount = candidates.filter((candidate) => toSatang(candidate.amountThb) === wanted);

  if (byAmount.length === 0) {
    return { matched: false, reason: 'no_amount_match', refs: [] };
  }

  const named = byAmount.filter((candidate) => containsReference(transfer.text, candidate.ref));

  if (named.length > 1) {
    return { matched: false, reason: 'ambiguous', refs: named.map((candidate) => candidate.ref) };
  }

  if (named.length === 0) {
    const payable = byAmount.filter((candidate) => isPayable(candidate, transfer.receivedAt));
    if (payable.length > 0) {
      return { matched: false, reason: 'no_reference', refs: payable.map((c) => c.ref) };
    }
    return { matched: false, reason: 'not_payable', refs: byAmount.map((c) => c.ref) };
  }

  const candidate = named[0]!;
  if (!isPayable(candidate, transfer.receivedAt)) {
    return { matched: false, reason: 'not_payable', refs: [candidate.ref] };
  }

  return { matched: true, ref: candidate.ref };
}

/**
 * Whether a QR was still payable when the money arrived.
 *
 * `expires_at > receivedAt`, deliberately the strict inequality the database uses
 * (`and "expires_at" > now()`), and measured against the *bank's* instant rather
 * than the moment this code runs: a notification that took ten minutes to reach
 * the bridge was still a payment made inside the window.
 */
export function isPayable(candidate: IntentCandidate, at: Date): boolean {
  return candidate.status === 'pending' && candidate.expiresAt.getTime() > at.getTime();
}

/**
 * Whether the notification names this reference.
 *
 * A *token* match — the reference must stand alone, bounded by characters that
 * cannot be part of one. Both the fragment check and the join check are load
 * bearing: a customer's memo `K7M2Q` is a different reference and must not close
 * a bill, and a search that scrubbed punctuation out of the text first would read
 * `0K7M2QX9` as `K7M2QX` and close one that nobody named.
 *
 * Case-folded because the reference alphabet (`payment-intents.ts`) excludes the
 * vowels and the confusable characters, so folding can never make two different
 * references equal.
 */
export function containsReference(text: string, ref: string): boolean {
  const wanted = ref.toUpperCase();
  if (wanted.length === 0) {
    return false;
  }

  const haystack = text.toUpperCase();
  let from = 0;

  for (;;) {
    const at = haystack.indexOf(wanted, from);
    if (at === -1) {
      return false;
    }
    const before = at === 0 ? null : haystack[at - 1]!;
    const afterAt = at + wanted.length;
    const after = afterAt >= haystack.length ? null : haystack[afterAt]!;

    if (isBoundary(before ?? ' ') && isBoundary(after ?? ' ')) {
      return true;
    }
    from = at + 1;
  }
}

/** A character that cannot be part of a reference, and so may bound one. */
function isBoundary(character: string): boolean {
  return !/[0-9A-Z]/.test(character);
}

function toSatang(amountThb: number): number {
  return Math.round(amountThb * 100);
}
