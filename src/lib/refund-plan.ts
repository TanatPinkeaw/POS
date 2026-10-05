/**
 * What a partial refund is worth.
 *
 * A full refund is easy — the customer paid ฿290, so they get ฿290 back — and that
 * is why this shipped first. A partial one is not: the money has to be split across
 * the lines that came back, the order-level discount has to be split with it, and
 * the pieces have to add back up to the invoice. Each note looks plausible on its
 * own, which is exactly what makes a rounding mistake here survive review: the shop
 * discovers it when somebody finally adds the notes up against the bill.
 *
 * The rule that makes the arithmetic safe is one sentence: **the note that empties
 * the order takes the remainder instead of computing its own share.** Every earlier
 * note rounds its pro-rata share of the discount, and the closing note is defined by
 * subtraction, so no split of the same sale can leave a satang stranded. There is a
 * test that walks a three-way split of ฿99.99 with a ฿5 discount and adds the notes
 * back up.
 *
 * Pure, for the same reason the VAT functions are: this figure ends up on a legal
 * document, and it should be checkable without a database.
 */
import { ValidationError } from './errors';
import { fromSatang, roundThb, toSatang } from './money';

/** A sale line, with what has already gone back against it. */
export interface RefundableLine {
  orderItemId: string;
  name: string;
  /** How many the sale had. */
  quantity: number;
  /** How many have already been refunded, across every earlier note. */
  returnedQuantity: number;
  /** What the line was charged, *before* the order-level discount. */
  totalPrice: number;
}

export interface RefundRequestLine {
  orderItemId: string;
  quantity: number;
}

export interface RefundedLine {
  orderItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  /** The gross share of this line, before the discount allocated to the note. */
  lineTotal: number;
}

export interface RefundPlan {
  /** In the sale's own order, so the note reads like the invoice it reverses. */
  lines: RefundedLine[];
  returnedUnits: number;
  /** The sum of the line totals, before discount. */
  grossThb: number;
  /** This note's share of the order-level discount. */
  discountThb: number;
  /** What the customer gets back. `grossThb - discountThb`, to the satang. */
  refundThb: number;
  /** True when this note leaves nothing refundable behind. */
  closes: boolean;
}

/**
 * Works out what to give back for the requested lines, or `null` requested for
 * everything still outstanding.
 *
 * Throws a `ValidationError` naming every problem it found rather than the first:
 * a counter has one conversation with the customer in front of it, and "and also
 * that one" three screens later is not one.
 */
export function planRefund(input: {
  lines: RefundableLine[];
  requested: RefundRequestLine[] | null;
  subtotalThb: number;
  discountThb: number;
  finalAmountThb: number;
  /**
   * What earlier notes on this sale already gave back.
   * The single figure carried across visits: the closing note is defined as the
   * remainder of the invoice, so what the other notes accounted for as *discount*
   * is already implied by it and does not need passing in.
   */
  alreadyRefundedThb: number;
}): RefundPlan {
  const problems: string[] = [];

  /* Merged, so two requests for the same line are one line worth two units. */
  const wanted = new Map<string, number>();
  for (const request of input.requested ?? []) {
    wanted.set(request.orderItemId, (wanted.get(request.orderItemId) ?? 0) + request.quantity);
  }

  const planned: RefundedLine[] = [];
  /** What each line gives back, so "does this empty the order" can be asked once. */
  const takingBack = new Map<string, number>();

  for (const line of input.lines) {
    const remaining = line.quantity - line.returnedQuantity;

    if (input.requested === null) {
      if (remaining > 0) {
        planned.push(toRefundedLine(line, remaining));
        takingBack.set(line.orderItemId, remaining);
      }
      continue;
    }

    const requested = wanted.get(line.orderItemId);
    if (requested === undefined) {
      continue;
    }
    wanted.delete(line.orderItemId);

    if (!Number.isInteger(requested) || requested <= 0) {
      problems.push(
        `จำนวนของ "${line.name}" ต้องเป็นจำนวนเต็มที่มากกว่า 0`,
      );
      continue;
    }
    if (requested > remaining) {
      problems.push(
        remaining === 0
          ? `"${line.name}" ถูกคืนไปหมดแล้ว`
          : `"${line.name}" เหลือคืนได้อีก ${remaining} ชิ้น`,
      );
      continue;
    }

    planned.push(toRefundedLine(line, requested));
    takingBack.set(line.orderItemId, requested);
  }

  for (const orderItemId of wanted.keys()) {
    problems.push('มีรายการที่ขอคืนเงิน แต่ไม่พบในบิลนี้');
  }

  if (input.requested !== null && planned.length === 0 && problems.length === 0) {
    problems.push('การคืนเงินต้องเลือกอย่างน้อย 1 รายการ');
  }

  if (problems.length > 0) {
    throw new ValidationError(problems.join('; '));
  }

  const returnedUnits = planned.reduce((total, line) => total + line.quantity, 0);
  /*
   * Summed in satang, not in baht. Adding two-decimal floats drifts — three notes
   * of ฿31.66 reach ฿94.99000000000001 — and the whole point of this module is that
   * the notes foot to the invoice exactly.
   */
  const grossSatang = planned.reduce((total, line) => total + toSatang(line.lineTotal), 0);
  const grossThb = fromSatang(grossSatang);

  /*
   * Does this note leave anything refundable behind? Asked of the sale rather than
   * inferred from what was requested, so explicitly naming every remaining line is
   * the same thing as asking for everything — which is what a till does when the
   * cashier ticks each row by hand instead of pressing "all".
   */
  const closes = input.lines.every(
    (line) => line.returnedQuantity + (takingBack.get(line.orderItemId) ?? 0) === line.quantity,
  );

  /*
   * The closing note is *defined* by what is left rather than computed from its
   * own lines. Everything before it rounds, and a round is a satang that has to
   * land somewhere; landing it here is what makes the notes foot to the invoice.
   */
  const refundSatang = closes
    ? toSatang(input.finalAmountThb) - toSatang(input.alreadyRefundedThb)
    : grossSatang -
      toSatang(proRataDiscount(input.discountThb, grossThb, input.subtotalThb));
  const refundThb = fromSatang(refundSatang);

  /*
   * The discount is the residual in both cases, which is what keeps
   * `gross − discount = refund` true on every note rather than approximately true.
   */
  const discountThb = fromSatang(grossSatang - refundSatang);

  if (refundThb <= 0 || discountThb < 0) {
    throw new ValidationError(
      'ยอดคืนเงินเป็นศูนย์ — เพราะบิลนี้ถูกคืนไปหมดแล้ว',
    );
  }

  return {
    lines: planned,
    returnedUnits,
    grossThb,
    discountThb,
    refundThb,
    closes,
  };
}

function toRefundedLine(line: RefundableLine, quantity: number): RefundedLine {
  /*
   * An order-level discount does not change what a single unit was priced at — and
   * the sale records a line *total*, not a unit price, so a partial return of a
   * line divides that total evenly. A line whose total does not split exactly (three
   * units for ฿100) therefore leaves a satang of gross on the closing note, which is
   * where every other remainder in this module lands too.
   */
  const unitPrice = roundThb(line.totalPrice / line.quantity);
  return {
    orderItemId: line.orderItemId,
    name: line.name,
    quantity,
    unitPrice,
    lineTotal: fromSatang(toSatang(unitPrice) * quantity),
  };
}

/** The share of an order-level discount that belongs to this much gross. */
function proRataDiscount(discountThb: number, grossThb: number, subtotalThb: number): number {
  if (discountThb <= 0 || subtotalThb <= 0) {
    return 0;
  }
  return roundThb((discountThb * grossThb) / subtotalThb);
}

/**
 * The tax inside a refund, matching the sale's own snapshot rather than today's
 * settings.
 *
 * `inclusive` and `ratePercent` come off the order being reversed, so a shop that
 * changes its VAT rate either way cannot rewrite the tax on a document that was
 * already issued — the same rule the receipt follows.
 *
 * `netOverride` exists for the closing note: the last document takes the tax the
 * earlier ones did not round to, so the sale's net and VAT are reconstructed
 * exactly by the notes that reverse it, to the satang.
 */
export function refundTax(input: {
  refundThb: number;
  /** The rate the *sale* used, off its own snapshot. Zero for a non-VAT shop. */
  ratePercent: number;
  isVatInvoice: boolean;
  /**
   * For the note that closes the sale: the tax the earlier notes did not round to.
   * Which is simply the sale's own net less what they already claimed.
   */
  netOverride?: number | null;
}): { netThb: number; vatThb: number } {
  if (!input.isVatInvoice || input.ratePercent <= 0) {
    return { netThb: input.refundThb, vatThb: 0 };
  }

  const satang = toSatang(input.refundThb);

  if (input.netOverride !== undefined && input.netOverride !== null) {
    const netSatang = toSatang(roundThb(input.netOverride));
    return { netThb: fromSatang(netSatang), vatThb: fromSatang(satang - netSatang) };
  }

  /*
   * `gross × rate ÷ (100 + rate)` whatever the shop's pricing convention, which is
   * not obvious and worth stating: for a VAT-inclusive shelf price the tax is
   * *derived* from the gross, and for an exclusive one the gross is net + tax — and
   * solving that second equation for the tax gives the same expression. The note
   * only ever has the gross to work from, and both roads lead here.
   */
  const vatSatang = Math.round((satang * input.ratePercent) / (100 + input.ratePercent));
  return { netThb: fromSatang(satang - vatSatang), vatThb: fromSatang(vatSatang) };
}
