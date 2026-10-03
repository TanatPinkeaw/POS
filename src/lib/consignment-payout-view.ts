/**
 * What a browser is allowed to know about paying a consignor.
 *
 * Separate from `consignment-payout.ts`, which imports the database client: a type or a
 * label imported into a client component must not drag `prisma` into the browser bundle.
 * This is the same split `product-view.ts` makes, and for the same reason.
 */

/** How a payout left the shop. The two doors money already leaves through (ADR 0004). */
export type PayoutMethod = 'cash' | 'promptpay';

export const PAYOUT_METHODS: readonly { value: PayoutMethod; label: string }[] = [
  { value: 'cash', label: 'เงินสด (จากลิ้นชัก)' },
  { value: 'promptpay', label: 'โอนผ่านแอปธนาคาร' },
];

/** The label for a method, falling back to the raw value for an unknown one. */
export function payoutMethodLabel(method: PayoutMethod): string {
  return PAYOUT_METHODS.find((option) => option.value === method)?.label ?? method;
}
