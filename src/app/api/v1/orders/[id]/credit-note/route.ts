/**
 * `GET /api/v1/orders/[id]/credit-note` — reprint data for a credit note.
 *
 * The sibling of the receipt route, and it exists for the same reason: a document
 * number is worthless if the document behind it cannot be produced again. What a
 * shop is asked for, months later, is the paper trail — the invoice *and* the
 * credit note that reversed it — so both are reprintable from the order.
 *
 * Two figures are answered from different places, deliberately:
 *
 *   * The credit note's own tax lines come from its snapshot columns, so a
 *     reprint of a 2026 note shows the rate that was reversed in 2026.
 *   * The shop's name and address come from the settings as they are **now**,
 *     because a renamed shop reprints under its new name. Same rule as the
 *     receipt, for the same reason (ADR 0002).
 */
import { withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { creditNoteShop, requireCreditNoteDocument } from '@/lib/credit-notes';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    // Employees too: the person at the counter is the one asked for a copy.
    await requireRole(['employee', 'admin']);

    const { id } = await context.params;
    const document = await requireCreditNoteDocument(id);
    const shop = await creditNoteShop();

    return { shop, creditNote: document };
  });
}
