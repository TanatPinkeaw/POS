/**
 * A product's consignment terms, and taking the goods back (ADR 0023).
 *
 *   * **PATCH** puts the product into consignment or re-agrees the member and share.
 *     Both halves travel together (the schema refuses one without the other), because
 *     a consignor with no share is a liability the shop cannot settle.
 *   * **POST** withdraws the unsold goods: the shelf is changed through the SRS §4.3
 *     stock path and the liability ends in the same transaction.
 *
 * Admin-only, both methods. Goods belonging to somebody else inside the shop is a
 * liability, and the person who decides to take it on is the owner — not the cashier
 * who happens to be at the counter when a member asks.
 *
 * Withdrawal is a `POST` to the same address rather than a `DELETE`, matching the
 * rest of this API's state changes (`confirm`, `cancel`, `refund`): a `DELETE` on a
 * product would read as "remove the product", and this removes an arrangement.
 */
import { readJson, withApi } from '@/lib/api';
import { requireRole } from '@/lib/auth';
import { setConsignment, withdrawConsignment } from '@/lib/consignment';
import { prisma } from '@/lib/db';
import { consignmentTermsSchema, consignmentWithdrawalSchema } from '@/lib/schemas';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, consignmentTermsSchema);

    return prisma.$transaction((tx) =>
      setConsignment(tx, {
        productId: id,
        consignorUserId: body.consignorUserId,
        sharePercent: body.sharePercent,
        actorId: session.id,
      }),
    );
  });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return withApi(async () => {
    const session = await requireRole(['admin']);
    const { id } = await context.params;
    const body = await readJson(request, consignmentWithdrawalSchema);

    return prisma.$transaction((tx) =>
      withdrawConsignment(tx, {
        productId: id,
        actorId: session.id,
        note: body.note ?? null,
      }),
    );
  });
}
