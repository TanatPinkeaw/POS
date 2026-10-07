/**
 * What the basket currently holds — the one place the storefront's numbers come from.
 *
 * Pure, and in `src/lib` rather than inside the screen, because two readers now
 * depend on the same decision: the card that lists the lines, and the bar that
 * follows the customer down the catalogue on a phone. A second copy of
 * `price × quantity` beside the first is exactly how a customer ends up reading one
 * total on the bar and a different one in the basket — and it is how the bar could
 * show a count for something the basket refused to price.
 */

import { roundThb, sumThb } from './money';

/** The part of a product the basket needs. Passed in, so this stays free of the database. */
export interface BasketProduct {
  id: string;
  name: string;
  /** THB, as the storefront already carries it. */
  salePrice: number;
}

export interface BasketLine {
  productId: string;
  name: string;
  quantity: number;
  amountThb: number;
}

export interface BasketSummary {
  lines: BasketLine[];
  /**
   * Pieces, not lines.
   *
   * A customer counts goods: two of one drink is two things to pick off the shelf,
   * and the count is what the bar says out loud while they keep shopping. The card
   * lists lines, which is the right unit for *reading* a basket — so the two numbers
   * are different on purpose and neither contradicts the other.
   */
  units: number;
  totalThb: number;
}

/**
 * The basket implied by the quantities the screen is holding.
 *
 * `quantities` is keyed by product id and only positive whole numbers survive:
 * anything else is a state the steppers cannot produce, and a basket is not the
 * place to find out what a fractional piece costs.
 */
export function basketSummary(
  quantities: Readonly<Record<string, number>>,
  products: readonly BasketProduct[],
): BasketSummary {
  const byId = new Map(products.map((product) => [product.id, product]));
  const lines: BasketLine[] = [];

  for (const [productId, quantity] of Object.entries(quantities)) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      continue;
    }

    /*
     * A product that has left the catalogue is dropped from the count *as well as*
     * the total. The inline version this replaced kept such an id in its `selected`
     * list while contributing nothing to the sum — so a basket could hold a line at
     * ฿0.00 and keep the reserve button enabled for it.
     *
     * This is not hypothetical on this screen: the catalogue is re-read from the
     * server after a reservation, so a product deactivated in the meantime is
     * exactly the shape that arrives here.
     */
    const product = byId.get(productId);
    if (!product) {
      continue;
    }

    lines.push({
      productId,
      name: product.name,
      quantity,
      amountThb: roundThb(product.salePrice * quantity),
    });
  }

  return {
    lines,
    units: lines.reduce((total, line) => total + line.quantity, 0),
    /*
     * Integer satang for the sum, so `0.1 + 0.2` cannot surface on a screen as
     * ฿0.30000000000000004. This is a *display* total — the server recomputes what
     * the bill owes from its own rows — but a total the customer can read is still a
     * total that has to be a number a shop would recognise.
     */
    totalThb: sumThb(lines.map((line) => line.amountThb)),
  };
}
