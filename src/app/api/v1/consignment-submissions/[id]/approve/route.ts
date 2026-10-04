/**
 * `POST /api/v1/consignment-submissions/:id/approve` — an owner takes a member's
 * offer on (ADR 0025).
 *
 * Admin only, and that is not a formality: this is the click that creates a product,
 * puts somebody else's goods on the shelf and writes the share the shop will owe on
 * every future sale of it. The cashier at the counter cannot do it, for the same
 * reason the cashier cannot set a share by hand.
 *
 * Everything it writes happens in one transaction, so a product that exists without a
 * share — or a share without a stock movement — is a state the database cannot be in.
 * The share itself is set by the *existing* `setConsignment`, not by a second
 * implementation of the same rule; this route decides when it happens, not what it is.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { approveSubmission } from '@/lib/consignment-intake';
import { prisma } from '@/lib/db';
import { consignmentApprovalSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, consignmentApprovalSchema);

    return prisma.$transaction((tx) =>
      approveSubmission(tx, {
        submissionId: id,
        actorId: session.id,
        sharePercent: body.sharePercent,
        salePriceThb: body.salePriceThb ?? null,
        receivedQty: body.receivedQty ?? null,
        categoryId: body.categoryId ?? null,
        consignorUserId: body.consignorUserId ?? null,
        note: body.note ?? null,
      }),
    );
  });
}
