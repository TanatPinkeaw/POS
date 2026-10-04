/**
 * Writing one product, with the barcode rule in one place.
 *
 * A barcode belongs to at most one product, and that promise has two halves. The
 * half that holds under load is the unique index: a pre-check is only ever advice,
 * and two admins entering the same supplier's new line at the same instant both
 * pass it. The half that helps the person typing is the sentence naming *which*
 * product already carries the code.
 *
 * Left to itself, the first half produces the opposite of the second. The loser of
 * that race gets Prisma's `P2002`, which `withApi` does not recognise, so it is
 * reported as "Something went wrong on our side" with a 500 — nothing in which
 * tells a shop that the barcode it just typed is one its own catalogue already
 * uses. That is a worse answer than no check at all, because it sends the renter
 * looking for a bug in the shop instead of at the label in their hand.
 *
 * So every single-product write goes through here. The pre-check stays, because
 * refusing before the write is cheaper and is right almost every time; the index
 * stays the authority; and its refusal is translated into the same sentence the
 * pre-check would have produced. The lookup after the failure is what keeps that
 * sentence specific — by then the other row exists, which is the point.
 *
 * Bulk import deliberately does not come through here. It matches rows to products
 * *by* barcode (ADR 0002), so a code already in the catalogue is an update rather
 * than a clash.
 */
import { prisma } from './db';
import { ValidationError } from './errors';
import { isUniqueViolation } from './prisma-errors';

/**
 * Runs a product write, refusing a barcode that another product already owns.
 *
 * `exceptProductId` is the product being edited: a form that saves an unchanged
 * row must not report that row as a clash with itself.
 */
export async function writeProductWithBarcode<T>(
  barcode: string | null | undefined,
  write: () => Promise<T>,
  options: { exceptProductId?: string } = {},
): Promise<T> {
  if (barcode) {
    const owner = await barcodeOwner(barcode, options.exceptProductId);
    if (owner) {
      throw new ValidationError(barcodeTakenMessage(barcode, owner.name));
    }
  }

  try {
    return await write();
  } catch (error) {
    /*
     * Only the barcode rule is translated. Anything else — a missing row, a
     * constraint on another column — is not this function's to explain, and
     * swallowing it here would hide a real failure behind a message about barcodes.
     */
    if (!barcode || !isUniqueViolation(error)) {
      throw error;
    }

    const owner = await barcodeOwner(barcode, options.exceptProductId);
    throw new ValidationError(
      owner
        ? barcodeTakenMessage(barcode, owner.name)
        : `Barcode ${barcode} is already used by another product`,
    );
  }
}

/** The product already carrying a barcode, or null when the code is free. */
async function barcodeOwner(
  barcode: string,
  exceptProductId?: string,
): Promise<{ id: string; name: string } | null> {
  const product = await prisma.products.findUnique({
    where: { barcode },
    select: { id: true, name: true },
  });

  if (!product) {
    return null;
  }

  /*
   * Identity is compared without regard to case, because a uuid does not have one:
   * Postgres matches `A` and `a` to the same row, so every `where: { id }` in this
   * codebase is case-insensitive, and a caller holding an id out of a URL path has
   * not been obliged to lowercase it. Comparing the two as spellings instead makes
   * a product that saves its own barcode look like a product clashing with itself.
   */
  if (exceptProductId && product.id === exceptProductId.toLowerCase()) {
    return null;
  }

  return product;
}

/**
 * The wording both doors produce, kept in one place so the pre-check and the
 * after-the-fact refusal cannot drift apart.
 */
function barcodeTakenMessage(barcode: string, ownerName: string): string {
  return `Barcode ${barcode} is already used by "${ownerName}"`;
}
